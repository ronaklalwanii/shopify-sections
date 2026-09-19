# Section Library

A local library of Shopify sections across all your stores — filter by store or
type, preview every section with realistic mock data, and add your own sections
for future reference.

## Run

```bash
npm install        # once
node src/ingest.js # re-scan shopify-stores/ (run after adding a store)
npm start          # → http://localhost:4173
```

## Usage

- **Filter** by store and category in the sidebar; search across names, files, and tags.
- Functional/page sections (main-*, drawers, account pages) are hidden behind
  "Show functional sections" — they're rarely what you're browsing for.
- **Click a card** to open the preview: desktop/tablet/mobile iframe, full Liquid
  source, copy, and download as a ready-to-drop `.liquid` file.
- **+ Add section** stores your own Liquid (+ optional CSS/JS) with a live preview.
  Saves commit to `custom-sections/`, which is its own git repo — push it anywhere
  to back up your personal snippet library.
- Reclassify a section by adding it to `data/tag-overrides.json`
  (`{ "store/file.liquid": { "category": "Stats" } }`) and re-running ingest.

## How previews work

Sections are Liquid, so the server renders them at request time with
[liquidjs](https://github.com/harttle/liquidjs) plus a mock Shopify layer:
schema settings get defaults/preset content, images become deterministic SVG
placeholders, `settings_data.json` supplies the store's real theme settings,
and translations come from the theme locales. Each preview loads the store's
own CSS assets inside a sandboxed iframe, so sections look like they do on the
real store. Sections depending on live store data (real products, metafields,
app blocks) show sample data instead.

## Layout

```
src/ingest.js    scan shopify-stores/* → data/index.json (schemas, categories)
src/renderer.js  liquidjs engine, Shopify mocks, filters & custom tags
src/server.js    API, preview routes, placeholder SVGs, custom section CRUD
public/          frontend (vanilla JS)
custom-sections/ your saved sections — standalone git repo
```

Supported stores live in `../shopify-stores/<name>` (each a full theme export
with `sections/`, `snippets/`, `assets/`, `config/`, `locales/`).
