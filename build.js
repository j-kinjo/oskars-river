#!/usr/bin/env node
// Oskar's River — build script
// Wraps app.js + style.css + data into dist/index.html
// Does NOT depend on index.template.html

const fs   = require('fs');
const path = require('path');
const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');

for (const f of ['app.js', 'style.css', 'foods.json']) {
  if (!fs.existsSync(path.join(ROOT, f))) {
    console.error(`ERROR: missing ${f}`); process.exit(1);
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

let js = appJs;
// app.js uses __BUILD_ID__ as a placeholder token
js = js.replace(/__BUILD_ID__/g, `build ${buildId}`);
js = `window.__RIVER_HISTORY__ = ${history};\nwindow.__RIVER_FOODS__ = ${foods};\n\n` + js;

// Read favicon from index.template.html if it exists, otherwise use default
let favicon = `<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><circle cx='16' cy='16' r='15' fill='%23050912' stroke='%233ecfa0' stroke-width='1.5'/><path d='M8 22 Q10 16 16 16 Q22 16 24 10' fill='none' stroke='%233ecfa0' stroke-width='2' stroke-linecap='round'/><circle cx='16' cy='16' r='2.5' fill='%233ecfa0'/></svg>" type="image/svg+xml">`;

// Try to get the meta/link tags from the template
const tmplPath = path.join(ROOT, 'index.template.html');
let extraHead = '';
if (fs.existsSync(tmplPath)) {
  const tmpl = fs.readFileSync(tmplPath, 'utf8');
  // Extract everything between <head> and </head> except style/script
  const headMatch = tmpl.match(/<head>([\s\S]*?)<\/head>/);
  if (headMatch) {
    extraHead = headMatch[1]
      .replace(/<link[^>]*stylesheet[^>]*href="style\.css"[^>]*>/g, '')
      .replace(/<script[^>]*app\.bundle\.js[^>]*><\/script>/g, '')
      .replace(/<style>[\s\S]*?<\/style>/g, '')
      .replace(/<script>[\s\S]*?<\/script>/g, '')
      .replace(/<title>[^<]*<\/title>/g, '')
      .trim();
  }
}

// Extract body content from template (without script/style)
let bodyContent = '';
if (fs.existsSync(tmplPath)) {
  const tmpl = fs.readFileSync(tmplPath, 'utf8');
  const bodyMatch = tmpl.match(/<body[^>]*>([\s\S]*?)<\/body>/);
  if (bodyMatch) {
    bodyContent = bodyMatch[1]
      .replace(/<script[^>]*>[\s\S]*?<\/script>/g, '')
      .trim();
  }
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>Oskar's River</title>
${extraHead}
<style>
${css}
</style>
</head>
<body>
${bodyContent}
<script>
${js}
</script>
</body>
</html>`;

fs.writeFileSync(path.join(DIST, 'index.html'), html);
const kb = (html.length/1024).toFixed(0);
console.log(`✓ dist/index.html: ${kb}KB  [build ${buildId}]`);
console.log(`  history: ${JSON.parse(history).length} entries`);
console.log(`  foods: ${JSON.parse(foods).length} items`);
console.log(`  fixes present: histAt=${js.includes('EMPTY = { bg: 7.0')}, updateHUD=${js.includes("isNaN(d.bg)")}`);
console.log(`Build complete`);
