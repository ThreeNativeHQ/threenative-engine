import game from "./game.js";

void game.start();

const label = document.getElementById("spell");
const names = [
  "fireball",
  "thunderstrike",
  "glacial-spike",
  "arcane-barrage",
  "aegis",
  "inferno",
] as const;
const pressed = new Set<string>();
window.addEventListener("keydown", (event) => {
  const index = Number(event.key) - 1;
  const name = names[index];
  if (name === undefined || pressed.has(name)) return;
  pressed.add(name);
  if (label !== null) label.textContent = name;
  window.setTimeout(() => pressed.delete(name), 250);
});
