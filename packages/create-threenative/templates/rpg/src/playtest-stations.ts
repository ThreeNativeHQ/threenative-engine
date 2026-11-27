// Playtest stations: each key puts the party at a fixed test spot or rigs the leader's next dice,
// so one scenario proves one rule in a few ticks instead of a long walk and a lucky roll.
// They answer only under a playtest runner. Delete them with the playtests that use them.
import type { Actor } from "./entities/Actor.js";
import { POST } from "./level.js";
import type { World } from "./systems/world.js";

function place(actor: Actor, x: number, z: number, yaw: number): void {
  actor.mesh.position.set(x, actor.mesh.position.y, z);
  actor.body.teleport(actor.mesh.position);
  actor.figure.rotation.y = yaw;
}

/** Leader beside a point, facing it; the other members stand a few metres behind. */
function leadTo(world: World, x: number, z: number, yaw: number, ahead = 3): void {
  const leader = world.leader;
  place(leader, x, z, yaw);
  let row = 1;
  for (const member of world.members) {
    if (member === leader) continue;
    place(member, x - Math.sin(yaw) * (ahead + row), z - Math.cos(yaw) * (ahead + row), yaw);
    row += 1;
  }
}

export const STATIONS: Readonly<Record<string, (world: World) => void>> = {
  // At the training post, a placeable with the flat defense of 10.
  station1: (world) => leadTo(world, POST.x + 1.5, POST.z, -Math.PI / 2),
  // Three metres from the elder, from the wanderer and from the sellsword.
  station2: (world) => leadTo(world, 2.5, 10.5, Math.PI / 2),
  station3: (world) => leadTo(world, -3.5, 10.5, -Math.PI / 2),
  station4: (world) => leadTo(world, 5, 13.5, Math.PI / 2),
  // On the road, a step short of the raiders' notice.
  station5: (world) => leadTo(world, 0, -2.5, Math.PI),
  // Inside the ruin, 1.7 m from the first raider: both sides are in reach and a round starts at once.
  station6: (world) => {
    place(world.leader, -4.5, -11.3, Math.PI);
    for (const member of world.members)
      if (member !== world.leader) place(member, -2, -10.5, Math.PI);
  },
  // Rigged dice for the leader's next attack (d20, then the confirming d20, then damage dice).
  // The hero's attack bonus is +3 (+4 once Melee reaches 10) and a raider or the post defends at 10.
  station7: (world) => world.dice.rig(world.leader.id, [20, 20, 8]),
  station8: (world) => world.dice.rig(world.leader.id, [1]),
  station9: (world) => world.dice.rig(world.leader.id, [6]),
  station10: (world) => world.dice.rig(world.leader.id, [7, 3]),
  station11: (world) => world.dice.rig(world.leader.id, [19, 3, 4]),
  // The next skill check: a 12 passes the elder's DC 12, a 2 fails it.
  station12: (world) => world.dice.rig(world.leader.id, [12]),
  station13: (world) => world.dice.rig(world.leader.id, [2]),
  // A wound of 10 on the leader, then the ruin cleared, then the leader down.
  station14: (world) => world.leader.receiveDamage(10),
  station15: (world) => {
    for (const raider of world.raiders) world.defeat(raider);
  },
  station16: (world) => world.defeat(world.leader),
  // The leader alone in the far corner of the ruin: followers at the camp must find the gate.
  // The ruin is cleared first: every spot in the yard is inside a raider's notice, and a fight
  // would replace the walk this station proves.
  station17: (world) => {
    for (const raider of world.raiders) world.defeat(raider);
    place(world.leader, -10, -14, Math.PI);
  },
};
