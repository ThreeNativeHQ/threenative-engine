// catalog.js — every piece in the kit with the option sets shown in the viewer.
// Each variant is just the argument you would pass to the generator yourself.
import * as Kit from './index.js';

export const BIOMES = { forest: 'Alpine forest', snow: 'Snow peaks', desert: 'Desert canyon', shared: 'Water and sky' };

export const CATALOG = [
  // ── Alpine forest ──
  { id: 'mountain-alpine', name: 'Alpine mountain ridge', biome: 'forest', fn: 'mountain', variants: [
    { seed: 3, width: 54, depth: 40, height: 31, palette: 'alpine' }, { seed: 8, width: 66, depth: 46, height: 39, palette: 'alpine' }] },
  { id: 'cliff-alpine', name: 'Grass-top cliff', biome: 'forest', fn: 'cliff', variants: [
    { seed: 3, width: 18, depth: 12, height: 20, steps: 2 }, { seed: 8, width: 13, depth: 10, height: 13, steps: 1 }, { seed: 12, width: 10, depth: 8, height: 8, taper: 0.95 }] },
  { id: 'boulder-alpine', name: 'Granite boulder', biome: 'forest', fn: 'boulder', variants: [{ seed: 2, size: 2.6 }, { seed: 5, size: 1.7 }, { seed: 9, size: 1.1, squash: [1.2, 0.6, 0.9] }] },
  { id: 'pebbles-alpine', name: 'Pebbles', biome: 'forest', fn: 'pebbles', variants: [{ seed: 4 }, { seed: 7, count: 9, spread: 2.2 }] },
  { id: 'pine', name: 'Pine', biome: 'forest', fn: 'pine', variants: [
    { seed: 1, height: 15 }, { seed: 2, height: 11, palette: 'teal' }, { seed: 3, height: 8 }, { seed: 4, height: 4.5, palette: 'teal' }] },
  { id: 'pine-olive', name: 'Sunlit pine', biome: 'forest', fn: 'pine', variants: [{ seed: 6, height: 13, palette: 'olive' }, { seed: 7, height: 9, palette: 'olive' }] },
  { id: 'pine-sparse', name: 'Sparse pine', biome: 'forest', fn: 'pine', variants: [{ seed: 11, height: 12, density: 0.45, bare: 0.3 }, { seed: 14, height: 9, density: 0.5, bare: 0.35, palette: 'teal' }] },
  { id: 'round-tree', name: 'Broadleaf tree', biome: 'forest', fn: 'roundTree', variants: [{ seed: 2, height: 7 }, { seed: 5, height: 5.5, palette: 'deep' }, { seed: 8, height: 6, palette: 'autumn' }] },
  { id: 'dead-tree', name: 'Dead tree', biome: 'forest', fn: 'deadTree', variants: [{ seed: 3, height: 7, bark: 'brown' }, { seed: 6, height: 5 }] },
  { id: 'log', name: 'Fallen log', biome: 'forest', fn: 'log', variants: [{ seed: 1 }, { seed: 4, length: 2.2, radius: 0.24 }] },
  { id: 'stump', name: 'Stump', biome: 'forest', fn: 'stump', variants: [{ seed: 2 }] },
  { id: 'bush', name: 'Bush', biome: 'forest', fn: 'bush', variants: [{ seed: 1, size: 1.2 }, { seed: 4, size: 0.8, palette: 'deep' }] },
  { id: 'fern', name: 'Fern', biome: 'forest', fn: 'fern', variants: [{ seed: 1, size: 0.9 }, { seed: 3, size: 0.6, palette: 'deep' }] },
  { id: 'grass', name: 'Grass tuft', biome: 'forest', fn: 'grassTuft', variants: [{ seed: 1 }, { seed: 2, height: 0.9, blades: 14, spread: 0.4 }] },
  { id: 'flowers', name: 'Daisies', biome: 'forest', fn: 'flowers', variants: [{ seed: 1 }, { seed: 2, color: 0xffe36b, heart: 0xf08a2b, count: 9 }] },
  { id: 'ground-grass', name: 'Grass patch', biome: 'forest', fn: 'groundPatch', variants: [{ seed: 1, radius: 6 }] },

  // ── Snow peaks ──
  { id: 'mountain-snow', name: 'Snow mountain ridge', biome: 'snow', fn: 'mountain', variants: [
    { seed: 3, width: 64, depth: 48, height: 44, palette: 'snow' }, { seed: 8, width: 76, depth: 54, height: 52, palette: 'snow' }] },
  { id: 'cliff-snow', name: 'Snow plateau', biome: 'snow', fn: 'cliff', variants: [
    { seed: 21, width: 16, depth: 13, height: 12, palette: 'snow', taper: 1.0, lip: 1.3, steps: 2 }, { seed: 24, width: 12, depth: 10, height: 8, palette: 'snow', taper: 1.0, lip: 1.1, steps: 1 }, { seed: 27, width: 8, depth: 7, height: 5, palette: 'snow', taper: 1.05, lip: 0.9 }] },
  { id: 'spires', name: 'Ice spires', biome: 'snow', fn: 'spires', variants: [{ seed: 2, height: 18, count: 5 }, { seed: 5, height: 12, count: 4, radius: 2 }, { seed: 9, height: 7, count: 3, radius: 1.5 }] },
  { id: 'boulder-snow', name: 'Snow boulder', biome: 'snow', fn: 'boulder', variants: [{ seed: 3, size: 2.4, palette: 'snow', snowy: true }, { seed: 6, size: 1.5, palette: 'snow', snowy: true }, { seed: 8, size: 1, palette: 'alpine', snowy: true }] },
  { id: 'pebbles-snow', name: 'Snowy stones', biome: 'snow', fn: 'pebbles', variants: [{ seed: 5, palette: 'snow', snowy: true, size: 0.45 }] },
  { id: 'pine-snow', name: 'Snow pine', biome: 'snow', fn: 'pine', variants: [{ seed: 31, height: 13, palette: 'snow' }, { seed: 32, height: 9, palette: 'snow' }, { seed: 33, height: 5, palette: 'snow' }] },
  { id: 'frost-tree', name: 'Frosted tree', biome: 'snow', fn: 'roundTree', variants: [{ seed: 41, height: 7, palette: 'frost', bark: 'dark' }, { seed: 44, height: 5, palette: 'frost', bark: 'dark' }] },
  { id: 'dead-tree-snow', name: 'Bare tree', biome: 'snow', fn: 'deadTree', variants: [{ seed: 9, height: 6, snow: true }, { seed: 12, height: 4, snow: true }] },
  { id: 'log-snow', name: 'Snowy log', biome: 'snow', fn: 'log', variants: [{ seed: 6, snow: true, bark: 'grey' }] },
  { id: 'stump-snow', name: 'Snowy stump', biome: 'snow', fn: 'stump', variants: [{ seed: 3, snow: true, bark: 'grey' }] },
  { id: 'bush-snow', name: 'Frosted bush', biome: 'snow', fn: 'bush', variants: [{ seed: 7, palette: 'frost' }, { seed: 9, size: 0.7, palette: 'frost' }] },
  { id: 'grass-frost', name: 'Frost grass', biome: 'snow', fn: 'grassTuft', variants: [{ seed: 5, palette: 'frost', height: 0.45 }] },
  { id: 'ground-snow', name: 'Snow drift', biome: 'snow', fn: 'groundPatch', variants: [{ seed: 4, radius: 6, palette: 'snow', bump: 1.4 }] },

  // ── Desert canyon ──
  { id: 'mountain-desert', name: 'Sandstone mountain ridge', biome: 'desert', fn: 'mountain', variants: [
    { seed: 3, width: 70, depth: 40, height: 36, palette: 'desert' }, { seed: 8, width: 82, depth: 46, height: 44, palette: 'desert' }] },
  { id: 'mesa-pillar', name: 'Mesa pillar', biome: 'desert', fn: 'mesa', variants: [{ seed: 1, height: 22, radius: 7 }, { seed: 4, height: 15, radius: 5.5 }, { seed: 7, height: 10, radius: 4 }] },
  { id: 'mesa-block', name: 'Canyon wall', biome: 'desert', fn: 'mesa', variants: [{ seed: 11, height: 20, radius: 6.5, shape: 'block', sx: 2.2 }, { seed: 13, height: 12, radius: 6, shape: 'butte', sx: 1.5 }] },
  { id: 'mesa-shelf', name: 'Rock shelf', biome: 'desert', fn: 'mesa', variants: [{ seed: 21, height: 12, radius: 7, shape: 'shelf', sx: 1.3 }, { seed: 23, height: 7, radius: 5, shape: 'shelf' }, { seed: 25, height: 4, radius: 3.4, shape: 'shelf' }] },
  { id: 'hoodoo', name: 'Hoodoo', biome: 'desert', fn: 'mesa', variants: [{ seed: 31, height: 13, radius: 3, shape: 'hoodoo' }, { seed: 33, height: 8, radius: 2.2, shape: 'hoodoo' }] },
  { id: 'arch', name: 'Stone arch', biome: 'desert', fn: 'arch', variants: [{ seed: 2, span: 24, height: 14 }, { seed: 5, span: 14, height: 8, thickness: 3, depth: 4.5 }] },
  { id: 'boulder-desert', name: 'Sandstone rock', biome: 'desert', fn: 'boulder', variants: [{ seed: 2, size: 2, palette: 'desert', squash: [1.2, 0.6, 1] }, { seed: 6, size: 1.2, palette: 'desert' }] },
  { id: 'pebbles-desert', name: 'Desert stones', biome: 'desert', fn: 'pebbles', variants: [{ seed: 3, palette: 'desert' }] },
  { id: 'palm', name: 'Palm', biome: 'desert', fn: 'palm', variants: [{ seed: 1, height: 9 }, { seed: 3, height: 6.5, lean: 0.3 }, { seed: 5, height: 3.5, lean: 0.12, coconuts: false }] },
  { id: 'saguaro', name: 'Saguaro', biome: 'desert', fn: 'saguaro', variants: [{ seed: 1, height: 5.5, arms: 2 }, { seed: 4, height: 4, arms: 3 }, { seed: 6, height: 2.6, arms: 1 }] },
  { id: 'column-cactus', name: 'Column cactus', biome: 'desert', fn: 'columnCactus', variants: [{ seed: 2, count: 5, height: 3.6 }, { seed: 5, count: 3, height: 2.2 }] },
  { id: 'twisted-tree', name: 'Twisted tree', biome: 'desert', fn: 'twistedTree', variants: [{ seed: 2, height: 4.5 }, { seed: 6, height: 3.2 }] },
  { id: 'shrub', name: 'Desert scrub', biome: 'desert', fn: 'shrub', variants: [{ seed: 1 }, { seed: 3, size: 0.6 }] },
  { id: 'broadleaf', name: 'Broadleaf plant', biome: 'desert', fn: 'fern', variants: [{ seed: 4, size: 1.1, palette: 'palm', serr: 0, wide: 0.3, fronds: 8 }, { seed: 7, size: 0.8, palette: 'desert', serr: 0, wide: 0.3, fronds: 7 }] },
  { id: 'grass-dry', name: 'Dry grass', biome: 'desert', fn: 'grassTuft', variants: [{ seed: 3, palette: 'dry', height: 0.45 }] },
  { id: 'ground-sand', name: 'Sand dune', biome: 'desert', fn: 'groundPatch', variants: [{ seed: 6, radius: 7, palette: 'sand', bump: 1.6 }] },

  { id: 'terrain-sample', name: 'Terrain and trail sample', biome: 'forest', fn: 'terrainSample', variants: [
    { seed: 1 }, { seed: 4, palette: 'snow' }, { seed: 6, palette: 'sand' }] },

  // ── Water and sky ──
  { id: 'sky-dome', name: 'Sky dome', biome: 'shared', fn: 'sky', variants: [
    {}, { top: 0x3a8be8, horizon: 0xe2f1ff }, { top: 0x2488ea, horizon: 0xe6cfd0 }] },
  { id: 'water', name: 'Pond', biome: 'shared', fn: 'water', variants: [{ width: 16, length: 16 }, { width: 10, length: 10, palette: 'ice' }] },
  { id: 'waterfall', name: 'Waterfall', biome: 'shared', fn: 'waterfall', variants: [{ seed: 1, width: 7, height: 10 }, { seed: 2, width: 4, height: 6 }, { seed: 3, width: 2, height: 3.5, throwDist: 0.8 }] },
  { id: 'cloud', name: 'Cloud', biome: 'shared', fn: 'cloud', variants: [{ seed: 1, size: 9 }, { seed: 4, size: 6 }] },
];

/** Build a catalog piece. */
export function build(entry, variant = 0, overrides = {}) {
  return Kit[entry.fn]({ ...entry.variants[variant], ...overrides });
}

/** The line of code that reproduces a piece. */
export function snippet(entry, opts) {
  const body = Object.entries(opts).map(([k, v]) => `${k}: ${typeof v === 'number' && (k === 'color' || k === 'heart') ? '0x' + v.toString(16) : JSON.stringify(v)}`).join(', ');
  return `Kit.${entry.fn}({ ${body} })`;
}
