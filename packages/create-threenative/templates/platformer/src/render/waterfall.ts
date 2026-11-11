// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// One waterfall: two translucent sheets that narrow at the lip and spread as they fall, streaks
// scrolling down them for motion without a texture, and foam where the water lands. Every prop on
// the cliffs behind the route is one of these, and `update` is the whole per-frame cost.
import { CylinderGeometry, Group, Mesh, PlaneGeometry, SphereGeometry } from "three";
import { flat } from "./materials.js";
import { C } from "./palette.js";

export function waterfall(
  width: number,
  height: number,
): { group: Group; update(dt: number): void } {
  const group = new Group();
  const streaks: Mesh[] = [];
  for (let i = 0; i < 2; i += 1) {
    const material = flat(i ? C.water : 0x4fb6e8, { opacity: i ? 0.55 : 0.9 });
    material.depthWrite = false;
    // Narrower at the lip, spreading as it falls.
    const sheet = new Mesh(
      new CylinderGeometry(
        width * (i ? 0.34 : 0.5),
        width * (i ? 0.44 : 0.62),
        height,
        8,
        1,
        true,
        -0.9,
        1.8,
      ),
      material,
    );
    sheet.position.set(0, -height / 2, i * 0.25);
    group.add(sheet);
    // Vertical streaks give the sheet motion without a texture.
    for (let s = 0; s < 4; s += 1) {
      const streak = new Mesh(
        new PlaneGeometry(
          width * (0.05 + Math.random() * 0.05),
          height * (0.12 + Math.random() * 0.2),
        ),
        flat(0xffffff, { opacity: 0.5 }),
      );
      streak.position.set(
        (Math.random() - 0.5) * width * 0.7,
        -Math.random() * height,
        width * 0.5,
      );
      streak.userData.speed = 8 + Math.random() * 10;
      streaks.push(streak);
      group.add(streak);
    }
  }
  for (let i = 0; i < 3; i += 1) {
    const lip = new Mesh(
      new SphereGeometry(width * (0.2 + Math.random() * 0.14), 8, 6),
      flat(0xffffff, { opacity: 0.9 }),
    );
    lip.position.set((Math.random() - 0.5) * width * 0.9, -0.2, width * 0.3);
    lip.scale.y = 0.55;
    group.add(lip);
  }
  for (let i = 0; i < 4; i += 1) {
    const puff = new Mesh(
      new SphereGeometry(width * (0.18 + Math.random() * 0.16), 8, 6),
      flat(0xffffff, { opacity: 0.75 }),
    );
    puff.position.set(
      (Math.random() - 0.5) * width * 1.4,
      -height + Math.random() * 0.8,
      (Math.random() - 0.5) * 1.2,
    );
    puff.scale.y = 0.7;
    group.add(puff);
  }
  return {
    group,
    update(dt: number): void {
      for (const streak of streaks) {
        streak.position.y -= (streak.userData.speed as number) * dt;
        if (streak.position.y < -height) streak.position.y = 0;
      }
    },
  };
}
