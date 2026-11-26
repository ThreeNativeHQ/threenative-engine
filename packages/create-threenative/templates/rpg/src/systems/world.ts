// The rules of the game, in one place: who fights whom, what a round does, who is in the party.
// The scene reads input and draws; this file decides. Nothing here touches the renderer.
import { Vector3 } from "three";
import { QUESTS, RUIN_QUEST, RUIN_RAIDERS, TREES } from "../content.js";
import type { Actor, ICombatant } from "../entities/Actor.js";
import { emitPlaytestEvent } from "../playtest-events.js";
import { OBJECT_DEFENSE, abilityModifier, resolveAttack } from "../rules/d20.js";
import type { Dice } from "../rules/dice.js";
import { Conversation, type IWorld } from "../rules/dialogue.js";
import { Party } from "../rules/party.js";
import { QuestLog } from "../rules/quests.js";
import { CombatRounds } from "../rules/rounds.js";
import { SKILL_GAIN, SKILL_LABEL, type SkillId, persuasionBonus, useSkill } from "../rules/skills.js";
import type { GamePhase } from "../state.js";

/** Metres within which a raider notices the party and the whole ruin turns on it. */
export const AGGRO_RADIUS = 9;
/** Metres a fighter must be within to swing. */
export const MELEE_REACH = 1.8;
/** Metres within which `E` finds someone to talk to, and `F` finds something to hit. */
export const TALK_RANGE = 7;
export const TARGET_RANGE = 14;
export const HEAL_AMOUNT = 12;
const LOG_LINES = 6;

/** The training post. A placeable: flat defense 10 (card `attack-roll`), no hit points, no revenge. */
export class Post implements ICombatant {
  readonly id = "post";
  readonly name = "Training post";
  readonly team = "object" as const;
  readonly defense = OBJECT_DEFENSE;
  readonly alive = true;
  hits = 0;
  readonly position: Vector3;

  constructor(x: number, z: number) {
    this.position = new Vector3(x, 0.9, z);
  }

  receiveDamage(): void {
    this.hits += 1;
  }
}

export interface ILastAttack {
  roll: number;
  outcome: "" | "miss" | "hit" | "critical";
  damage: number;
  automatic: "" | "hit" | "miss";
}

export class World implements IWorld {
  readonly actors = new Map<string, Actor>();
  readonly rounds = new CombatRounds();
  readonly party = new Party();
  readonly quests = new QuestLog(QUESTS);
  readonly conversation = new Conversation();
  readonly post: Post;
  readonly dice: Dice;
  phase: GamePhase = "playing";
  coins = 0;
  medpacks = 3;
  kills = 0;
  log: string[] = [];
  message = "";
  messageTimer = 0;
  targetId = "";
  /** The ruin has seen the party: its raiders hunt until none is left. */
  alerted = false;
  /** Who the open conversation is with. */
  npc = "";
  lastCheck = "";
  lastCheckPassed = 0;
  readonly last: ILastAttack = { automatic: "", damage: 0, outcome: "", roll: 0 };

  constructor(actors: readonly Actor[], post: Post, dice: Dice) {
    for (const actor of actors) this.actors.set(actor.id, actor);
    this.post = post;
    this.dice = dice;
    for (const actor of actors) if (actor.team === "party") this.party.add(actor.id);
  }

  get partyFull(): boolean {
    return this.party.full;
  }

  stage(quest: string): number {
    return this.quests.stage(quest);
  }

  get leader(): Actor {
    const leader = this.actors.get(this.party.leader);
    if (leader === undefined) throw new Error("The party has no leader.");
    return leader;
  }

  get members(): Actor[] {
    return this.party.members.flatMap((id) => {
      const actor = this.actors.get(id);
      return actor === undefined ? [] : [actor];
    });
  }

  get raiders(): Actor[] {
    return [...this.actors.values()].filter((actor) => actor.team === "raider");
  }

  get inCombat(): boolean {
    return this.rounds.active || (this.alerted && this.raiders.some((raider) => raider.alive));
  }

  combatant(id: string): ICombatant | undefined {
    return id === this.post.id ? this.post : this.actors.get(id);
  }

  /** Things the leader can hit: the raiders still standing, and the post. */
  foes(): ICombatant[] {
    return [...this.raiders.filter((raider) => raider.alive), this.post];
  }

  say(text: string): void {
    this.message = text;
    this.messageTimer = 2.5;
  }

  note(line: string): void {
    this.log.push(line);
    if (this.log.length > LOG_LINES) this.log.shift();
  }

  gain(actor: Actor, skill: SkillId, points: number): void {
    if (!useSkill(actor.skills, skill, points)) return;
    emitPlaytestEvent({ entity: actor.id, name: "skill-rose", skill });
    if (actor === this.leader)
      this.note(`${actor.name}: ${SKILL_LABEL[skill]} rose to ${actor.skills[skill].level}.`);
  }

  /** Keep the target valid, and pick the nearest foe when it is not. */
  retarget(): void {
    const leader = this.leader.position;
    const current = this.targetId === "" ? undefined : this.combatant(this.targetId);
    if (current?.alive === true && current.position.distanceTo(leader) <= TARGET_RANGE) return;
    this.targetId = "";
    let best = Number.POSITIVE_INFINITY;
    for (const foe of this.foes()) {
      const distance = foe.position.distanceTo(leader);
      if (distance < best && distance <= TARGET_RANGE) {
        best = distance;
        this.targetId = foe.id;
      }
    }
  }

  cycleTarget(): void {
    const near = this.foes().filter(
      (foe) => foe.position.distanceTo(this.leader.position) <= TARGET_RANGE,
    );
    if (near.length === 0) return;
    const index = near.findIndex((foe) => foe.id === this.targetId);
    this.targetId = near[(index + 1) % near.length]?.id ?? "";
  }

  /** The leader changes: every queue empties and the camera follows. */
  rotateLeader(): void {
    if (this.party.members.length < 2) return;
    this.party.rotate((id) => this.actors.get(id)?.alive === true);
    for (const actor of this.actors.values()) actor.queue.clear();
    this.say(`${this.leader.name} leads`);
    emitPlaytestEvent({ entity: this.leader.id, name: "leader" });
  }

  /** Advance the rounds one tick and apply what they decide. */
  update(dt: number): void {
    this.messageTimer = Math.max(0, this.messageTimer - dt);
    if (this.messageTimer === 0) this.message = "";
    for (const event of this.rounds.update(dt)) {
      if (event.kind === "end") {
        for (const id of event.attackers) {
          const actor = this.actors.get(id);
          if (actor !== undefined) actor.locked = false;
        }
        continue;
      }
      const attacker = this.actors.get(event.attack.attacker);
      const target = this.combatant(event.attack.target);
      if (attacker?.alive !== true || target?.alive !== true) continue;
      if (event.kind === "swing") {
        attacker.face(target.position.x, target.position.z, 1);
        attacker.swing();
      } else this.#resolve(attacker, target);
    }
    if (this.phase === "playing" && !this.members.some((member) => member.alive)) {
      this.phase = "lost";
      this.say("The party has fallen");
    }
  }

  #resolve(attacker: Actor, target: ICombatant): void {
    const result = resolveAttack(
      this.dice.for(attacker.id),
      attacker.attackBonus,
      target.defense,
      attacker.stats.weapon,
      attacker.damageModifier,
    );
    const word = result.outcome === "miss" ? "misses" : result.outcome === "hit" ? "hits" : "CRITS";
    const sign = result.bonus >= 0 ? "+" : "";
    this.note(
      `${attacker.name} ${word} ${target.name}: d20 ${result.roll}${sign}${result.bonus} vs ${result.defense}` +
        (result.damage > 0 ? `, ${result.damage} damage` : ""),
    );
    if (attacker === this.leader) {
      this.last.roll = result.roll;
      this.last.outcome = result.outcome;
      this.last.damage = result.damage;
      this.last.automatic = result.automatic ?? "";
    }
    emitPlaytestEvent({ entity: attacker.id, name: `attack-${result.outcome}`, roll: result.roll });
    this.gain(attacker, "melee", SKILL_GAIN.meleeSwing + (result.damage > 0 ? SKILL_GAIN.meleeHit : 0));
    if (result.damage === 0) return;
    target.receiveDamage(result.damage);
    if ((target as Actor).team === "raider") this.alerted = true;
    if (!target.alive) this.#down(target as Actor);
  }

  #down(fallen: Actor): void {
    for (const id of this.rounds.cancel(fallen.id)) {
      const freed = this.actors.get(id);
      if (freed !== undefined) freed.locked = false;
    }
    for (const actor of this.actors.values()) actor.queue.drop(fallen.id);
    if (fallen.team === "raider") {
      this.kills += 1;
      this.note(`${fallen.name} falls.`);
      emitPlaytestEvent({ entity: fallen.id, name: "kill" });
      if (this.kills >= RUIN_RAIDERS && this.quests.stage(RUIN_QUEST) === 1) this.#stage(RUIN_QUEST, 2);
      return;
    }
    this.note(`${fallen.name} is down.`);
    if (fallen === this.leader && this.members.some((member) => member.alive)) {
      this.party.rotate((id) => this.actors.get(id)?.alive === true);
      this.say(`${this.leader.name} leads`);
    }
  }

  #stage(quest: string, stage: number): void {
    if (!this.quests.advance(quest, stage)) return;
    const def = this.quests.view().find((view) => view.id === quest);
    this.note(`Journal: ${def?.title ?? quest} updated.`);
    this.say("Journal updated");
    emitPlaytestEvent({ entity: "journal", name: `quest-${quest}-${stage}` });
    if (stage >= 3) {
      this.phase = "won";
      this.say("Quest complete");
    }
  }

  /** Open a talk with a villager. Refused while a fight runs. */
  startConversation(id: string, treeId: string): void {
    if (this.inCombat) {
      this.say("Not now: a fight is on");
      return;
    }
    const tree = TREES[treeId];
    if (tree === undefined) return;
    this.npc = id;
    this.conversation.start(tree, this);
    emitPlaytestEvent({ entity: id, name: "talk" });
  }

  /** Take a numbered choice of the open conversation (0 based) and apply its effects. */
  choose(index: number): void {
    const leader = this.leader;
    const bonus = persuasionBonus(leader.skills) + abilityModifier(leader.stats.abilities.cha);
    const result = this.conversation.choose(index, this, this.dice.for(leader.id), bonus);
    if (result === undefined) return;
    if (result.check !== undefined) {
      const check = result.check;
      this.lastCheck = `${check.label} d20 ${check.roll} + ${check.bonus} vs ${check.dc}`;
      this.lastCheckPassed = check.passed ? 1 : 0;
      this.note(`${check.passed ? "Pass" : "Fail"}: ${this.lastCheck}`);
      emitPlaytestEvent({ entity: leader.id, name: check.passed ? "check-pass" : "check-fail" });
      this.gain(leader, "persuasion", check.passed ? SKILL_GAIN.persuadeWin : SKILL_GAIN.persuadeFail);
    }
    for (const effect of result.effects) this.#apply(effect);
    if (result.ended) this.npc = "";
  }

  #apply(effect: string): void {
    const [kind, a, b] = effect.split(":");
    if (kind === "quest" && a !== undefined && b !== undefined) this.#stage(a, Number(b));
    else if (kind === "coins") {
      this.coins += Number(a);
      this.note(`Received ${a} coins.`);
    } else if (kind === "recruit") {
      const recruit = this.actors.get(this.npc);
      if (recruit !== undefined && this.party.add(recruit.id)) {
        recruit.team = "party";
        recruit.queue.clear();
        this.say(`${recruit.name} joined the party`);
        emitPlaytestEvent({ entity: recruit.id, name: "recruit" });
      }
    } else if (kind === "refuse") {
      this.say("Party full");
      emitPlaytestEvent({ entity: this.npc, name: "recruit-refused" });
    }
  }
}
