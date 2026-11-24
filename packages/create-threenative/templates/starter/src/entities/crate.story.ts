// A code story (PRD-915): `pnpm dev`, then Asset Library -> Code stories -> crate. Tune the props
// with the controls, copy them back into Crate.ts, and the game is never booted to look at one box.
// Nothing imports this file, so it never reaches a build.
import { defineAssetStory } from "create-threenative/asset-story";
import { Color, Mesh, MeshStandardMaterial } from "three";
import { roundedBox } from "../render/shapes.js";

export default defineAssetStory<{ size: number; color: string; roughness: number }>({
  title: "Crate",
  category: "Entities",
  controls: [
    { key: "size", label: "Size (m)", type: "range", min: 0.25, max: 3, step: 0.05, default: 1 },
    { key: "color", label: "Colour", type: "color", default: "#b07a45" },
    {
      key: "roughness",
      label: "Roughness",
      type: "range",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.7,
    },
  ],
  create: ({ size, color, roughness }) => {
    const mesh = new Mesh(
      roundedBox(size, size, size),
      new MeshStandardMaterial({ color: new Color(color), roughness }),
    );
    mesh.position.y = size / 2;
    return mesh;
  },
});
