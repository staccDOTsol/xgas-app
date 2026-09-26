// Pure JS/WASM renderer for Open Graph cards: satori lays the card out as SVG (text becomes paths, so resvg needs
// no fonts), @resvg/resvg-wasm rasterises it to PNG. No native dependencies, so the Docker image needs nothing
// beyond `npm install`. Fonts are bundled TTFs in assets/fonts (OFL, licences beside them).
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import satori from 'satori';
import { initWasm, Resvg } from '@resvg/resvg-wasm';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FONT_DIR = path.join(ROOT, 'assets', 'fonts');

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

const FONT_FILES = [
  { name: 'Space Grotesk', file: 'SpaceGrotesk-Medium.ttf', weight: 500 },
  { name: 'Space Grotesk', file: 'SpaceGrotesk-Bold.ttf', weight: 700 },
  { name: 'JetBrains Mono', file: 'JetBrainsMono-Regular.ttf', weight: 400 },
  { name: 'JetBrains Mono', file: 'JetBrainsMono-Bold.ttf', weight: 700 },
];

let fonts = null;
let ready = null;

/** Loads the fonts and the resvg wasm once. Resolves true when rendering works, false when it cannot. */
export function initRenderer() {
  if (!ready) {
    ready = (async () => {
      fonts = FONT_FILES.map((f) => ({ name: f.name, weight: f.weight, style: 'normal', data: fs.readFileSync(path.join(FONT_DIR, f.file)) }));
      await initWasm(fs.readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));
      return true;
    })().catch((e) => {
      console.error('[og] renderer unavailable, link previews fall back to /og.png:', e?.message || e);
      return false;
    });
  }
  return ready;
}

/**
 * A tiny element factory in the shape satori reads (React-like, no JSX build step). Every div is a flex box,
 * which satori requires for anything with more than one child.
 */
export function h(type, props, ...children) {
  const p = props || {};
  const kids = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== '');
  const style = type === 'div' ? { display: 'flex', ...(p.style || {}) } : p.style;
  const out = { ...p, style };
  if (kids.length === 1) out.children = kids[0];
  else if (kids.length > 1) out.children = kids;
  return { type, props: out };
}

/** Renders an element tree to a 1200x630 PNG Buffer. Throws if the renderer is unavailable. */
export async function renderPng(tree) {
  if (!(await initRenderer())) throw new Error('renderer unavailable');
  const svg = await satori(tree, { width: OG_WIDTH, height: OG_HEIGHT, fonts });
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: OG_WIDTH }, background: '#0b0e17' });
  try {
    const img = resvg.render();
    try { return Buffer.from(img.asPng()); } finally { img.free(); }
  } finally { resvg.free(); }
}
