// stage-guest-ui.mjs -- PRD-784: put a game's built native-css UI beside game.js for the PS4 guest.
//
// The engine player draws the HUD from `<dir of game.js>/ui/` (v8_main.cpp), which is /app0/ui on
// PS4. The directory holds the stylesheets and the fonts and images they name, exactly what
// `threenative build` stages for a native-css game (`.threenative/build/ui-css`). The PS4 guest has
// no system fonts, so a UI that ships none gets one OFL font here.
import { copyFileSync, cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Noto Sans (SIL OFL 1.1), the font the native-css-hud example already ships. */
const FONT_DIR = path.resolve(HERE, '../../../../examples/native-css-hud/src/ui/fonts');
const FONT_SHEET = 'zz-ps4-fonts.css';
const FONT_RULES = `@font-face { font-family: "Noto Sans"; font-weight: 400; src: url(NotoSans-Regular.ttf); }
@font-face { font-family: "Noto Sans"; font-weight: 700; src: url(NotoSans-Bold.ttf); }
* { font-family: "Noto Sans"; }
`;

/**
 * Stage the scene's built UI into `<appDir>/ui`. Returns that path, or '' when the scene ships none.
 * The source is TN_PS4_UI_DIR, else `<scene>/.threenative/build/ui-css`.
 */
export function stageGuestUi(scene, appDir, env = process.env) {
  const source = env.TN_PS4_UI_DIR ? path.resolve(env.TN_PS4_UI_DIR) : path.join(scene, '.threenative', 'build', 'ui-css');
  // appDir outlives a run: a scene without a UI must not boot the previous scene's (the PS4 player
  // attaches native-css whenever ui/index.html exists, and a failed attach ends the game).
  const ui = path.join(appDir, 'ui');
  rmSync(ui, { force: true, recursive: true });
  if (!existsSync(source)) return '';
  const files = readdirSync(source);
  if (!files.some((name) => /\.css$/iu.test(name)))
    throw new Error(`TN_PS4_UI_NO_CSS: ${source} holds no .css; the native CSS engine paints nothing without one`);
  cpSync(source, ui, { recursive: true });
  // v8_main.cpp starts the UI only when ui/index.html exists; native-css reads no page from it.
  if (!existsSync(path.join(ui, 'index.html')))
    writeFileSync(path.join(ui, 'index.html'), '<!doctype html><meta charset="utf-8"><title>ui</title>\n');
  if (!files.some((name) => /\.(ttf|otf|woff2?)$/iu.test(name))) {
    for (const font of ['NotoSans-Regular.ttf', 'NotoSans-Bold.ttf', 'OFL.txt']) copyFileSync(path.join(FONT_DIR, font), path.join(ui, font));
    writeFileSync(path.join(ui, FONT_SHEET), FONT_RULES);
    // With a stylesheets.json only the named sheets load, so the font sheet joins the order, last.
    const order = path.join(ui, 'stylesheets.json');
    if (existsSync(order)) {
      const manifest = JSON.parse(readFileSync(order, 'utf8'));
      manifest.stylesheets.push(FONT_SHEET);
      writeFileSync(order, `${JSON.stringify(manifest)}\n`);
    }
  }
  return ui;
}
