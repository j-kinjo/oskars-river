#!/usr/bin/env node
/**
 * Oskar's River — build script
 * Works with flat file layout at repo root:
 *   app.js, style.css, index.template.html, foods.json, history.json
 */

const fs   = require('fs');
const path = require('path');

const ROOT = __dirname;

// File locations — flat at root
const PATHS = {
  template: path.join(ROOT, 'index.template.html'),
  appJs:    path.join(ROOT, 'app.js'),
  css:      path.join(ROOT, 'style.css'),
  history:  path.join(ROOT, 'history.json'),
  foods:    path.join(ROOT, 'foods.json'),
};

// Check all source files exist
let missing = false;
for (const [name, p] of Object.entries(PATHS)) {
  if (!fs.existsSync(p)) {
    console.error(`ERROR: missing ${name} at ${p}`);
    missing = true;
  }
}
if (missing) process.exit(1);

// Ensure dist/ exists
const DIST = path.join(ROOT, 'dist');
fs.mkdirSync(DIST, { recursive: true });

// Read source files
const template = fs.readFileSync(PATHS.template, 'utf8');
const appJs    = fs.readFileSync(PATHS.appJs,    'utf8');
const css      = fs.readFileSync(PATHS.css,      'utf8');
const history  = fs.readFileSync(PATHS.history,  'utf8');
const foods    = fs.readFileSync(PATHS.foods,    'utf8');

// Stamp build number
const buildNum = process.env.BUILD_NUMBER || process.env.GITHUB_RUN_NUMBER || 'dev';
const buildDate = new Date().toISOString().slice(0,10).replace(/-/g,'');
const buildId   = `${buildDate}-${buildNum}`;

let js = appJs;
js = js.replace(/build 2026\d{4}-\d+/g, `build ${buildId}`);
js = js.replace(/'build \d+'/, `'build ${buildId}'`);

// Inject data as globals before the app code
const dataBlock = [
  `// ── INJECTED BY BUILD ${buildId} ────────────────────────`,
  `window.__RIVER_HISTORY__ = ${history};`,
  `window.__RIVER_FOODS__   = ${foods};`,
  ''
].join('\n');

js = dataBlock + js;

// Assemble HTML
let html = template;
html = html.replace('<link rel="stylesheet" href="style.css">', `<style>\n${css}\n</style>`);
html = html.replace('<script src="app.bundle.js"></script>', `<script>\n${js}\n</script>`);

const outPath = path.join(DIST, 'index.html');
fs.writeFileSync(outPath, html);

const kb = (html.length / 1024).toFixed(0);
console.log(`✓ dist/index.html: ${kb}KB  [build ${buildId}]`);
console.log(`\nBuild complete → dist/index.html`);
