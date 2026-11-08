// The judges the macOS simulator run applies to its launch logs (PRD-842). A spec on Linux pins what
// each marker means: green for a healthy launch, and one red per failure the old text tests guarded.
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  judgeBundleMissing,
  judgePlainLaunch,
  judgePresentationCap,
  judgeWebUiLaunch,
} from '../scripts/ios-webui-log.mjs';

const FRAME = '{{0, 0}, {393, 852}}';
const healthy = [
  'TN_UI_OVERLAY:{"attached":true}',
  'TN_IOS_GAME_EVAL',
  `TN_UI_OVERLAY:{"loaded":true,"frame":"${FRAME}","parent":"${FRAME}"}`,
  'TN_UI_PAGE:{"type":"tn:ui-diagnostic","event":"ready"}',
  `TN_UI_OVERLAY:{"firstState":true,"frame":"${FRAME}","parent":"${FRAME}"}`,
  'TN_UI_PAGE:{"type":"tn:ui-diagnostic","event":"first-state"}',
].join('\n');

test('a healthy WebUI launch passes', () => {
  assert.deepEqual(judgeWebUiLaunch(healthy), []);
});

test.each([
  ['the overlay attaches after the game evaluates', healthy.replace('TN_UI_OVERLAY:{"attached":true}\nTN_IOS_GAME_EVAL', 'TN_IOS_GAME_EVAL\nTN_UI_OVERLAY:{"attached":true}'), /evaluated before the UI attached/u],
  ['the page load fails', `${healthy}\nTN_UI_OVERLAY:{"loaded":false,"error":"WKErrorDomain 1"}`, /failed to load/u],
  ['the page module never runs (bad MIME, no CORS, or a handler registered late)', healthy.replace(/TN_UI_PAGE:[^\n]*ready[^\n]*\n/u, ''), /module never ran/u],
  ['the page receives no state', healthy.replace(/\nTN_UI_PAGE:[^\n]*first-state[^\n]*/u, ''), /never received game state/u],
  ['the page logs an error', `${healthy}\nTN_UI_PAGE [error]: {"message":"x"}`, /logged an error/u],
  ['the overlay frame is not the parent bounds', healthy.replace('"frame":"{{0, 0}, {393, 852}}","parent":"{{0, 0}, {393, 852}}"}\nTN_UI_PAGE:{"type":"tn:ui-diagnostic","event":"first-state"', '"frame":"{{0, 0}, {852, 393}}","parent":"{{0, 0}, {393, 852}}"}\nTN_UI_PAGE:{"type":"tn:ui-diagnostic","event":"first-state"'), /not pinned to its parent/u],
])('a WebUI launch fails when %s', (_name, log, expected) => {
  assert.match(judgeWebUiLaunch(log).join('\n'), expected);
});

test('the plain launch must log no UI overlay line', () => {
  assert.deepEqual(judgePlainLaunch('[Mystral] Presentation cap: 60 fps'), []);
  assert.equal(judgePlainLaunch('TN_UI_OVERLAY:{"attached":true}').length, 1);
  assert.equal(judgePlainLaunch('TN_UI_PAGE:{}').length, 1);
});

test('the display cap reaches the host', () => {
  assert.deepEqual(judgePresentationCap('[Mystral] Presentation cap: 30 fps', 30), []);
  assert.equal(judgePresentationCap('[Mystral] Presentation cap: 60 fps', 30).length, 1);
});

test('a missing UI bundle refuses by name', () => {
  assert.deepEqual(judgeBundleMissing('TN_UI_BUNDLE_MISSING: selected WebUI has no ui/index.html'), []);
  assert.equal(judgeBundleMissing('').length, 1);
});
