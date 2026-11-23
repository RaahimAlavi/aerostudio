const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'cf-dist');
const PUBLIC_DIR = path.join(ROOT, 'public');

const THREE_FILES = ['three.module.js', 'three.core.js'];

const JAKARTA_FONTS = [
  'plus-jakarta-sans-latin-400-normal.woff2',
  'plus-jakarta-sans-latin-500-normal.woff2',
  'plus-jakarta-sans-latin-600-normal.woff2',
  'plus-jakarta-sans-latin-700-normal.woff2',
  'plus-jakarta-sans-latin-800-normal.woff2',
];

const MONO_FONTS = [
  'jetbrains-mono-latin-500-normal.woff2',
  'jetbrains-mono-latin-600-normal.woff2',
  'jetbrains-mono-latin-700-normal.woff2',
];

const PHOSPHOR_ICONS = [
  'arrow-u-up-left',
  'arrows-clockwise',
  'check',
  'corners-in',
  'corners-out',
  'eraser',
  'eye',
  'eye-slash',
  'lightbulb',
  'mouse',
  'paint-brush',
  'paint-bucket',
  'pencil-simple',
  'pulse',
  'qr-code',
  'skip-forward',
  'speaker-high',
  'speaker-slash',
  'trash',
];

function copyDirFiltered(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name.endsWith('.idsig')) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirFiltered(s, d);
    else fs.copyFileSync(s, d);
  }
}

function copyList(srcDir, destDir, files) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const f of files) {
    const src = path.join(srcDir, f);
    if (!fs.existsSync(src)) {
      throw new Error(`Missing required vendor asset: ${src}`);
    }
    fs.copyFileSync(src, path.join(destDir, f));
  }
}

if (fs.existsSync(OUT)) {
  fs.rmSync(OUT, { recursive: true, force: true });
}

copyDirFiltered(PUBLIC_DIR, OUT);
copyList(path.join(ROOT, 'node_modules', 'three', 'build'), path.join(OUT, 'vendor', 'three'), THREE_FILES);
copyList(
  path.join(ROOT, 'node_modules', '@fontsource', 'plus-jakarta-sans', 'files'),
  path.join(OUT, 'vendor', 'fonts', 'jakarta'),
  JAKARTA_FONTS
);
copyList(
  path.join(ROOT, 'node_modules', '@fontsource', 'jetbrains-mono', 'files'),
  path.join(OUT, 'vendor', 'fonts', 'mono'),
  MONO_FONTS
);
copyList(
  path.join(ROOT, 'node_modules', '@phosphor-icons', 'core', 'assets', 'bold'),
  path.join(OUT, 'vendor', 'icons'),
  PHOSPHOR_ICONS.map((n) => `${n}-bold.svg`)
);

console.log('Prepared Cloudflare Workers static bundle -> cf-dist/');
