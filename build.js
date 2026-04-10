#!/usr/bin/env node
/**
 * Oskar's River — build script
 *
 * Reads:
 *   src/index.template.html   — shell HTML (no inline data)
 *   src/app.js                — app code with __RIVER_HISTORY__ / __RIVER_FOODS__ stubs
 *   src/style.css             — styles
 *   data/history.json         — CGM history (322KB, kept separate)
 *   data/foods.json           — food database
 *
 * Writes:
 *   dist/index.html           — single deployable file (GitHub Pages)
 *   dist/data/history.json    — served separately (fetched at runtime)
 *   dist/data/foods.json
 *
 * Usage:
 *   node build.js             — full build (inlines latest data)
 *   node build.js --no-inline — reference data via fetch (smaller HTML)
 */

const fs   = require('fs');
const path = require('path');

const ROOT  = __dirname;
const SRC   = path.join(ROOT, 'src');
const DATA  = path.join(ROOT, 'data');
const DIST  = path.join(ROOT, 'dist');

const inlineData = !process.argv.includes('--no-inline');

// ── Ensure dist/ exists ──────────────────────────────────────────
fs.mkdirSync(DIST, { recursive: true });
fs.mkdirSync(path.join(DIST, 'data'), { recursive: true });

// ── Read source files ────────────────────────────────────────────
const template = fs.readFileSync(path.join(SRC, 'index.template.html'), 'utf8');
const appJs    = fs.readFileSync(path.join(SRC, 'app.js'), 'utf8');
const css      = fs.readFileSync(path.join(SRC, 'style.css'), 'utf8');
const history  = fs.readFileSync(path.join(DATA, 'history.json'), 'utf8');
const foods    = fs.readFileSync(path.join(DATA, 'foods.json'), 'utf8');

// ── Stamp build number ───────────────────────────────────────────
const now       = new Date();
const buildDate = now.toISOString().slice(0,10).replace(/-/g,'');
const buildNum  = process.env.BUILD_NUMBER || 'dev';
const buildId   = `${buildDate}-${buildNum}`;

let js = appJs.replace(/build 2026\d{4}-\d+/g, `build ${buildId}`);
js = js.replace("'build 65'", `'build ${buildId}'`);

// ── Inject data ───────────────────────────────────────────────────
if (inlineData) {
  // Inline history + foods as globals before the app code
  // This preserves current single-file behaviour
  const dataBlock = [
    `// ── INJECTED BY BUILD ${buildId} ────`,
    `window.__RIVER_HISTORY__ = ${history};`,
    `window.__RIVER_FOODS__   = ${foods};`,
    ''
  ].join('\n');

  js = dataBlock + js;
  console.log(`  Inlining data: history ${(history.length/1024).toFixed(0)}KB, foods ${(foods.length/1024).toFixed(0)}KB`);
} else {
  // Fetch mode: app loads data via fetch at runtime
  const fetchBlock = `
// ── FETCH DATA AT RUNTIME ────────────────────────────────────────
(async function loadData() {
  try {
    const [hRes, fRes] = await Promise.all([
      fetch('data/history.json'),
      fetch('data/foods.json'),
    ]);
    window.__RIVER_HISTORY__ = await hRes.json();
    window.__RIVER_FOODS__   = await fRes.json();
    console.log('[river] data loaded:', window.__RIVER_HISTORY__.length, 'entries');
  } catch(e) {
    console.warn('[river] data fetch failed, using empty arrays', e);
    window.__RIVER_HISTORY__ = [];
    window.__RIVER_FOODS__   = [];
  }
})();
`;
  js = fetchBlock + js;
}

// ── Assemble final HTML ───────────────────────────────────────────
let html = template;
html = html.replace('<link rel="stylesheet" href="style.css">', `<style>\n${css}\n</style>`);
html = html.replace('<script src="app.bundle.js"></script>', `<script>\n${js}\n</script>`);

const outPath = path.join(DIST, 'index.html');
fs.writeFileSync(outPath, html);
console.log(`✓ dist/index.html: ${(html.length/1024).toFixed(0)}KB  [build ${buildId}]`);

// ── Copy data files ───────────────────────────────────────────────
fs.copyFileSync(path.join(DATA, 'history.json'), path.join(DIST, 'data', 'history.json'));
fs.copyFileSync(path.join(DATA, 'foods.json'),   path.join(DIST, 'data', 'foods.json'));
console.log(`✓ dist/data/ copied`);

// ── Copy favicon if present ───────────────────────────────────────
const favSrc = path.join(SRC, 'favicon.svg');
if (fs.existsSync(favSrc)) {
  fs.copyFileSync(favSrc, path.join(DIST, 'favicon.svg'));
  console.log(`✓ favicon.svg copied`);
}

console.log(`\nBuild complete → dist/index.html`);
