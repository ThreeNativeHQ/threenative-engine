// Orders: what each queued action does while it is the front of an actor's queue, and who queues
// what for the followers and the raiders. The leader's queue is the player's own.
import type { Actor } from "../entities/Actor.js";
import { followStep } from "../rules/party.js";
import { type Action, ARRIVAL_RADIUS, INTERACTION_DISTANCE } from "../rules/queue.js";
import { SKILL_GAIN } from "../rules/skills.js";
import { emitPlaytestEvent } from "../playtest-events.js";
import { AGGRO_RADIUS, HEAL_AMOUNT, MELEE_REACH, type World } from "./world.js";

function distance(a: Actor, x: number, z: number): number {
  return Math.hypot(a.position.x - x, a.position.z - z);
}

/** Run the front action once. True when it is done and leaves the queue. */
export function stepAction(world: World, actor: Actor, action: Action, dt: number): boolean {
  switch (action.kind) {
    case "move": {
      const left = actor.stepToward(action.x, action.z, true, dt);
      return left <= ARRIVAL_RADIUS;
    }
    case "attack": {
      const target = world.combatant(action.target);
      if (target?.alive !== true) {
        actor.rest(dt);
        return !world.rounds.isBusy(actor.id);
      }
      const { x, z } = target.position;
      if (action.started) {
        actor.face(x, z, dt);
        actor.rest(dt);
        return !world.rounds.isBusy(actor.id);
      }
      if (distance(actor, x, z) > MELEE_REACH) {
        actor.stepToward(x, z, true, dt);
        return false;
      }
      actor.face(x, z, dt);
      actor.rest(dt);
      if (world.rounds.register(actor.id, target.id) !== "busy") {
        action.started = true;
        actor.locked = true;
        emitPlaytestEvent({ entity: actor.id, name: "round", target: target.id });
      }
      return false;
    }
    case "talk": {
      const npc = world.actors.get(action.npc);
      if (npc === undefined) return true;
      if (distance(actor, npc.position.x, npc.position.z) > INTERACTION_DISTANCE) {
        actor.stepToward(npc.position.x, npc.position.z, false, dt);
        return false;
      }
      actor.face(npc.position.x, npc.position.z, dt);
      npc.face(actor.position.x, actor.position.z, 1);
      actor.rest(dt);
      world.startConversation(npc.id, npc.treeId);
      return true;
    }
    case "heal": {
      const patient = world.actors.get(action.target);
      if (patient?.alive !== true) return true;
      if (distance(actor, patient.position.x, patient.position.z) > INTERACTION_DISTANCE) {
        actor.stepToward(patient.position.x, patient.position.z, true, dt);
        return false;
      }
      actor.rest(dt);
      if (world.medpacks <= 0) {
        world.say("No medpacks");
        return true;
      }
      world.medpacks -= 1;
      actor.heal();
      patient.restore(HEAL_AMOUNT);
      world.note(`${actor.name} heals ${patient.name}.`);
      emitPlaytestEvent({ entity: patient.id, name: "healed" });
      return true;
    }
    case "follow": {
      const slot = Math.max(0, world.party.members.indexOf(actor.id) - 1);
      const step = followStep(actor.position, world.leader.position, slot);
      if (step === undefined) actor.rest(dt);
      else actor.stepToward(step.x, step.z, step.run, dt);
      return false;
    }
  }
}

/** Queue an attack on the leader's target, replacing whatever the actor was doing. */
function engage(actor: Actor, targetId: string): void {
  const front = actor.queue.front;
  if (front?.kind === "attack" && front.target === targetId) return;
  actor.queue.clear();
  actor.queue.push({ kind: "attack", started: false, target: targetId });
}

/** Followers fight what the leader fights, and otherwise follow. */
export function directFollowers(world: World): void {
  const leader = world.leader;
  const foes = world.raiders.filter((raider) => raider.alive);
  for (const member of world.members) {
    if (member === leader || !member.alive) continue;
    const front = member.queue.front;
    if (world.alerted && foes.length > 0) {
      if (front?.kind === "heal") continue;
      const lead = world.targetId === "" ? undefined : world.combatant(world.targetId);
      const near = foes.reduce((best, foe) =>
        distance(member, foe.position.x, foe.position.z) <
        distance(member, best.position.x, best.position.z)
          ? foe
          : best,
      );
      engage(member, lead?.alive === true && lead.team === "raider" ? lead.id : near.id);
    } else if (member.queue.length === 0 || front?.kind === "attack") {
      member.queue.clear();
      member.queue.push({ kind: "follow" });
    }
  }
}

/** Raiders sleep until the party comes within the aggro radius, then every raider hunts. */
export function directRaiders(world: World): void {
  const alive = world.members.filter((member) => member.alive);
  const raiders = world.raiders.filter((raider) => raider.alive);
  if (!world.alerted) {
    const seen = raiders.some((raider) =>
      alive.some(
        (member) => distance(raider, member.position.x, member.position.z) <= AGGRO_RADIUS,
      ),
    );
    if (!seen) return;
    world.alerted = true;
    world.say("Raiders!");
    emitPlaytestEvent({ entity: "ruin", name: "alerted" });
  }
  for (const raider of raiders) {
    if (alive.length === 0) return;
    const front = raider.queue.front;
    if (front?.kind === "attack") {
      const current = world.actors.get(front.target);
      if (current?.alive === true && current.team === "party") continue;
    }
    const prey = alive.reduce((best, member) =>
      distance(raider, member.position.x, member.position.z) <
      distance(raider, best.position.x, best.position.z)
        ? member
        : best,
    );
    engage(raider, prey.id);
  }
}

/** Metres run turn into Athletics points, once a whole metre piles up. */
export function collectRunning(world: World): void {
  for (const actor of world.actors.values()) {
    if (actor.runMetres < 1) continue;
    const metres = Math.floor(actor.runMetres);
    actor.runMetres -= metres;
    if (actor.team === "party")
      world.gain(actor, "athletics", metres * SKILL_GAIN.athleticsPerMetre);
  }
}
