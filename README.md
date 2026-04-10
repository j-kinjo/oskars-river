# Oskar's River - 

T1D glycaemic companion — zenful void river with CGM integration.

## Project structure

```
river/
├── .github/
│   └── workflows/
│       └── deploy.yml      ← GitHub Actions: push to main → auto deploy
├── src/
│   ├── app.js              ← all app code (~144KB, no embedded data)
│   ├── style.css           ← all styles (~7KB)
│   └── index.template.html ← HTML shell (no inline data or script)
├── data/
│   ├── history.json        ← CGM history (267KB, committed to git)
│   └── foods.json          ← food database (65 items)
├── build.js                ← build script (inlines data → dist/index.html)
├── package.json
└── README.md
```

## How it works

`build.js` reads the template + app code + data files and produces a single
`dist/index.html` that GitHub Pages serves. The build is triggered automatically
by the GitHub Actions workflow on every push to `main`.

## Local development

```bash
node build.js          # build once → dist/index.html
open dist/index.html   # open in browser

# Or with live reload (requires npm i -g serve):
npm run dev
```

## Deploying manually

```bash
# Push any change to main and GitHub Actions deploys automatically
git add -A
git commit -m "your message"
git push origin main
# → workflow runs → dist/ deployed → live in ~30 seconds
```

## GitHub Pages setup (one-time)

1. Go to repo Settings → Pages
2. Source: **GitHub Actions** (not "Deploy from branch")
3. That's it — the workflow handles the rest

## Adding new CGM history

The `data/history.json` file is the committed historical record. New entries
logged via the app are stored in `localStorage` (`river_session`, `river_logged`)
and merged at runtime. A future Supabase migration will replace this.

## File size breakdown

| File | Size | Notes |
|------|------|-------|
| `src/app.js` | ~144KB | Pure app code, no data |
| `src/style.css` | ~7KB | All styles |
| `data/history.json` | ~267KB | 5108 CGM readings (17 Mar–27 Mar) |
| `data/foods.json` | ~7KB | 65 food items |
| **dist/index.html** | **~495KB** | Final single file (inline build) |
