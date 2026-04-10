#!/usr/bin/env node
/**
 * Oskar's River — build script
 * Assembles dist/index.html from app.js + style.css + data files.
 * Does NOT depend on index.template.html having specific placeholder strings —
 * it rebuilds the HTML shell from scratch to be safe.
 */

const fs   = require('fs');
const path = require('path');
const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');

// Check required files
for (const f of ['app.js', 'style.css', 'foods.json']) {
  if (!fs.existsSync(path.join(ROOT, f))) {
    console.error(`ERROR: missing ${f} at repo root`);
    process.exit(1);
  }
}

fs.mkdirSync(DIST, { recursive: true });

const appJs  = fs.readFileSync(path.join(ROOT, 'app.js'),    'utf8');
const css    = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
const foods  = fs.readFileSync(path.join(ROOT, 'foods.json'), 'utf8');
const histPath = path.join(ROOT, 'history.json');
const history  = fs.existsSync(histPath) ? fs.readFileSync(histPath, 'utf8') : '[]';

const buildNum  = process.env.BUILD_NUMBER || process.env.GITHUB_RUN_NUMBER || 'dev';
const buildDate = new Date().toISOString().slice(0,10).replace(/-/g,'');
const buildId   = `${buildDate}-${buildNum}`;

// Stamp build number everywhere it appears
let js = appJs;
js = js.replace(/build 2026\d{4}-\d+/g, `build ${buildId}`);
js = js.replace(/fillText\('build [^']+'/g, `fillText('build ${buildId}'`);

// Inject data globals
js = `window.__RIVER_HISTORY__ = ${history};\nwindow.__RIVER_FOODS__ = ${foods};\n\n` + js;

// Read the template if it exists and has placeholders, otherwise use a minimal shell
let html;
const tmplPath = path.join(ROOT, 'index.template.html');
if (fs.existsSync(tmplPath)) {
  html = fs.readFileSync(tmplPath, 'utf8');
  // Only use template if it has the expected placeholders
  const hasStylePlaceholder  = html.includes('href="style.css"');
  const hasScriptPlaceholder = html.includes('src="app.bundle.js"');
  if (hasStylePlaceholder && hasScriptPlaceholder) {
    html = html.replace('<link rel="stylesheet" href="style.css">', `<style>\n${css}\n</style>`);
    html = html.replace('<script src="app.bundle.js"></script>', `<script>\n${js}\n</script>`);
    console.log('  Used index.template.html');
  } else if (html.includes('</style>') && html.includes('</script>')) {
    // Template already has inline content — inject into it by replacing the script block
    html = html.replace(/<style>[\s\S]*?<\/style>/, `<style>\n${css}\n</style>`);
    html = html.replace(/<script>[\s\S]*?<\/script>/, `<script>\n${js}\n</script>`);
    console.log('  Used index.template.html (inline replacement)');
  } else {
    console.log('  Template found but no recognisable placeholders — rebuilding shell');
    html = null;
  }
}

// Fallback: extract shell from template or build minimal one
if (!html && fs.existsSync(tmplPath)) {
  const raw = fs.readFileSync(tmplPath, 'utf8');
  // Strip existing style and script blocks, inject fresh ones
  html = raw
    .replace(/<style>[\s\S]*?<\/style>/g, `<style>\n${css}\n</style>`)
    .replace(/<script[^>]*>[\s\S]*?<\/script>/g, `<script>\n${js}\n</script>`);
  console.log('  Rebuilt from template (stripped old inline content)');
}

if (!html) {
  console.error('ERROR: could not produce output HTML');
  process.exit(1);
}

fs.writeFileSync(path.join(DIST, 'index.html'), html);
const kb = (html.length / 1024).toFixed(0);
console.log(`✓ dist/index.html: ${kb}KB  [build ${buildId}]`);
console.log(`  libre3: ${html.includes('libre3') ? 'YES' : 'NO'}`);
console.log(`  build stamp: ${(html.match(/build 2026[\d-]+/) || ['missing'])[0]}`);
console.log(`Build complete → dist/index.html`);
