// What the HUD reads: the world's facts, rounded and shaped as the published state. Lists are set
// only when they change, so the HUD re-renders on a new fact and not on every tick.
import type { Actor } from "../entities/Actor.js";
import { SKILL_LABEL, type SkillId, pointsToRise } from "../rules/skills.js";
import type { GameState, MemberView, SkillView } from "../state.js";
import type { World } from "./world.js";

const round = (value: number, scale = 100): number => Math.round(value * scale) / scale;

interface IStore {
  set(patch: Partial<GameState>): void;
}

function memberView(world: World, actor: Actor): MemberView {
  return {
    down: !actor.alive,
    hp: actor.hp,
    id: actor.id,
    leader: actor === world.leader,
    maxHp: actor.maxHp,
    name: actor.name,
    queue: actor.queue.labels,
  };
}

export function publish(world: World): {
  toggleJournal: () => void;
  frame: (store: IStore, extra: { near: boolean; missionTime: number }) => void;
} {
  let journal = 0;
  const seen = new Map<string, string>();
  /** Set a list field only when its content changed since the last tick. */
  const changed = (key: string, value: unknown): boolean => {
    const next = JSON.stringify(value) ?? "";
    if (seen.get(key) === next) return false;
    seen.set(key, next);
    return true;
  };
  return {
    frame: (store, extra) => {
      const leader = world.leader;
      const patch: Partial<GameState> = {};
      const target = world.targetId === "" ? undefined : world.combatant(world.targetId);
      const dialogue = world.conversation.open
        ? {
            choices: world.conversation.view(world),
            speaker: world.conversation.node()?.speaker ?? "",
            text: world.conversation.node()?.text ?? "",
          }
        : undefined;
      const skills: SkillView[] = (["melee", "athletics", "persuasion"] as SkillId[]).map((id) => ({
        id,
        label: SKILL_LABEL[id],
        level: leader.skills[id].level,
        need: pointsToRise(leader.skills[id].level),
        progress: round(leader.skills[id].progress),
      }));
      const party = world.members.map((member) => memberView(world, member));
      if (changed("party", party)) patch.party = party;
      if (changed("skills", skills)) patch.skills = skills;
      const quests = world.quests.view();
      if (changed("quests", quests)) patch.quests = quests;
      if (changed("dialogue", dialogue)) patch.dialogue = dialogue;
      if (changed("log", world.log)) patch.log = [...world.log];
      store.set({
        ...patch,
        attackBonus: leader.attackBonus,
        coins: world.coins,
        inCombat: world.inCombat ? 1 : 0,
        journalOpen: journal,
        kills: world.kills,
        lastAutomatic: world.last.automatic,
        lastCheck: world.lastCheck,
        lastCheckPassed: world.lastCheckPassed,
        lastDamage: world.last.damage,
        lastOutcome: world.last.outcome,
        lastRoll: world.last.roll,
        leader: leader.id,
        medpacks: world.medpacks,
        message: world.message,
        missionTime: round(extra.missionTime, 10),
        phase: world.phase,
        playerX: round(leader.position.x),
        playerZ: round(leader.position.z),
        prompt:
          world.phase !== "playing"
            ? "R  RESTART"
            : world.conversation.open
              ? "1-4  CHOOSE    ESC  LEAVE"
              : extra.near
                ? "E  TALK"
                : target !== undefined
                  ? "F  ATTACK    T  TARGET"
                  : "",
        roundTime: round(world.rounds.elapsed(leader.id)),
        runSpeed: round(leader.runSpeed),
        shot: world.conversation.open ? "dialogue" : "overhead",
        target: target?.id ?? "",
        targetDefense: target?.defense ?? 0,
        targetHp: target !== undefined && "hp" in target ? (target as Actor).hp : 0,
        targetName: target?.name ?? "",
      });
    },
    toggleJournal: () => {
      journal = journal === 1 ? 0 : 1;
    },
  };
}
