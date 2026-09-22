# Section Library

A local library of Shopify sections across all your stores — filter by store or
type, preview every section with realistic mock data, and add your own sections
for future reference.

## Run

```bash
npm install        # once
node src/ingest.js # re-scan stores/ (run after adding a store)
npm start          # → http://localhost:4173
```

## Deploy (free, always-on for your team)

### Vercel (works with your existing account + domain)

The repo is Vercel-ready (`vercel.json` + `api/index.js`). Custom sections are
persisted through a private GitHub "data repo" (serverless has no disk).

1. Push this repo to a **private** GitHub repo.
2. Vercel → **Add New → Project → Import** the repo (framework: Other — no build step).
3. Environment variables:
   - `ACCESS_PASSWORD` — your team's login password
   - `STORE_URL`, `STOREFRONT_PASSWORD`, `PAGE_HANDLE=section-library` — live previews
   - `DATA_REPO` = `you/section-library-data`, `DATA_TOKEN` = a GitHub fine-grained
     token with **Contents: read/write** on that repo (create the empty private repo
     first). Without these, saved custom sections vanish on every function restart.
4. Deploy, then Settings → Domains → attach your domain.

Notes: the ~52MB `stores/` bundle ships inside the function; serverless cold starts
add ~1s to the first request after inactivity; the preview cache lives in `/tmp`
(warm until the instance recycles).

The app ships as a Docker container (`Dockerfile`) too — see the alternatives below.

### Hugging Face Spaces (easiest)

1. Create a **private** Space on huggingface.co → SDK: **Docker**.
2. Push this repo into the Space (Settings → remotes, or `git remote add space ...`).
3. In Space **Settings → Variables and secrets**, add:
   - `ACCESS_PASSWORD` — the login your team uses
   - `STORE_URL`, `STOREFRONT_PASSWORD`, `PAGE_HANDLE` — live-preview connection
   - optional `DATA_REPO` + `DATA_TOKEN` — a private GitHub repo (plus a fine-grained
     token with read/write on it) where saved custom sections are committed, so
     they survive restarts on ephemeral hosts.
4. Share the Space with your team (Settings → Members).

Note: free Spaces sleep after ~48h idle and wake in ~1 minute on the next visit;
the container filesystem is ephemeral, which is exactly what the `DATA_REPO`
persistence solves.

### Oracle Cloud Always Free (zero compromises)

Create an Always Free ARM VM, install Docker, then:

```bash
git clone <your-repo> && cd section-library
docker build -t section-library .
docker run -d --name section-library --restart unless-stopped -p 80:3000 \
  -v /opt/sl-data:/app/data -v /opt/sl-custom:/app/custom-sections \
  -e ACCESS_PASSWORD=... -e STORE_URL=... -e STOREFRONT_PASSWORD=... \
  section-library
```

No sleeping, persistent disk, and the VM stays inside the Always Free allowance.

### Configuration reference

| Env var | Purpose |
| --- | --- |
| `ACCESS_PASSWORD` | Team login gate (unset = open, fine for local use) |
| `STORE_URL` / `STOREFRONT_PASSWORD` / `PAGE_HANDLE` | Live-preview connection to the dev store |
| `PREVIEW_THEME_ID` | Optional preview-theme bypass |
| `DATA_REPO` / `DATA_TOKEN` | GitHub repo for custom-section persistence |
| `STORES_ROOTS` | Where theme folders live (default `stores/`) |
| `DATA_DIR` / `CUSTOM_DIR` | Writable paths (point at a volume on hosted runs) |

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
