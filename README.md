# Section Library

A local library of Shopify sections across all your stores — filter by store or
type, preview every section with realistic mock data, and add your own sections
for future reference.

## Adding sections

**Single sections (snippets you write):** use the **+ Add section** form in the app.
Saved sections persist to the `DATA_REPO` GitHub repo and survive restarts/redeploys.

**New themes (a store's section export):** no tooling needed —
- Drop the theme **zip** into the repo's `new-themes/` folder (drag-and-drop works
  on github.com), or drop an unzipped theme folder into `stores/<name>/`.
- Push. A GitHub Action unzips, re-ingests, and Vercel rebuilds automatically —
  new sections are live at the next deploy (~1 min).
- To reclassify a section, edit `data/tag-overrides.json`
  (`{ "store/file.liquid": { "category": "Stats" } }`) and push.

Note: themes are content-hash deduped, so shared sections across stores appear once.

## Export a section pack

Use **Add to pack** on any section card, reorder the selection, then choose one
of two one-time exports:

- **Ready-to-upload theme ZIP** — a `base` theme with the selected sections,
  namespaced dependencies, source CSS/JS, and `page.section-pack.json`.
- **Lightweight section pack ZIP** — selected sections and their dependencies
  for merging into an existing theme, with an import manifest.

The catalog and original store folders are never modified by an export.

## Run

```bash
npm install        # once
node src/ingest.js # re-scan stores/ (run after adding a store)
npm test           # syntax checks + regression tests
npm run qa:local   # render every unique section without live-store requests
npm start          # → http://localhost:4173
```

## Deploy (free, always-on for your team)

### Vercel (works with your existing account + domain)

The repo is Vercel-ready (`vercel.json` + `api/index.js`). Custom sections are
persisted through a private GitHub "data repo" (serverless has no disk).

1. Push this repo to a **private** GitHub repo.
2. Vercel → **Add New → Project → Import** the repo (framework: Other). The included
   `vercel.json` runs the catalog ingest during the build.
3. Environment variables:
   - `ACCESS_PASSWORD` — your team's login password
    - `STORE_URL`, `STOREFRONT_PASSWORD`, `PAGE_HANDLE=section-library` — optional live previews
    - `LIVE_PREVIEWS=1` — opt into live Shopify previews; local previews are the default

   - `DATA_REPO` = `you/section-library-data`, `DATA_TOKEN` = a GitHub fine-grained
     token with **Contents: read/write** on that repo (create the empty private repo
     first). Without these, saved custom sections vanish on every function restart.
4. Deploy, then Settings → Domains → attach your domain.

Notes: the ~52MB `stores/` bundle ships inside the function; serverless cold starts
add ~1s to the first request after inactivity; the preview cache lives in `/tmp`
(warm until the instance recycles).

The optional Shopify gallery publisher needs a ZIP URL that Shopify can fetch
without your GitHub credentials. A private GitHub Release asset is not sufficient;
use a deliberately public artifact repository or authenticated object storage.

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
   -v /opt/sl-data:/var/lib/section-library \
   -e DATA_DIR=/var/lib/section-library \
   -e CUSTOM_DIR=/var/lib/section-library/custom-sections \
   -e ACCESS_PASSWORD=... -e STORE_URL=... -e STOREFRONT_PASSWORD=... \
   section-library

```

No sleeping, persistent disk, and the VM stays inside the Always Free allowance.

### Configuration reference

| Env var | Purpose |
| --- | --- |
| `ACCESS_PASSWORD` | Team login gate (required when `NODE_ENV=production`; unset is open only for local development) |
| `PREVIEW_TOKEN_SECRET` | Optional stable secret for cross-instance preview assets; defaults to `ACCESS_PASSWORD` |
| `STORE_URL` / `STOREFRONT_PASSWORD` / `PAGE_HANDLE` | Live-preview connection to the dev store |
| `LIVE_PREVIEWS=1` | Opt into live Shopify previews; local previews are the default |
| `PREVIEW_THEME_ID` | Optional preview-theme bypass |
| `DATA_REPO` / `DATA_TOKEN` | GitHub repo for custom-section persistence |
| `STORES_ROOTS` | Where theme folders live (default `stores/`) |
| `DATA_DIR` / `CUSTOM_DIR` | Writable paths (point at a volume on hosted runs) |
| `QA_SKIP_LIVE=1` | Run the local QA sweep without contacting the live store |

## Usage

- **Filter** by store and category in the sidebar; search across names, files, and tags.
  The grid loads 48 cards at a time so large stores stay responsive.
- Functional/page sections (main-*, drawers, account pages) are hidden behind
  "Show functional sections" — they're rarely what you're browsing for.
- **Click a card** to open the preview: desktop/tablet/mobile iframe, full Liquid
  source, dependency list, copy, and source download. Cards show render-check,
  review, or issue status from the QA report. A source download may need the
  listed snippets/assets and the source theme's global CSS.
- **+ Add section** stores your own Liquid (+ optional CSS/JS) with a live preview.
  Saves commit to `custom-sections/`, which is its own git repo — push it anywhere
  to back up your personal snippet library.
- Reclassify a section by adding it to `data/tag-overrides.json`
  (`{ "store/file.liquid": { "category": "Stats" } }`) and re-running ingest.

## How previews work

Sections are Liquid, so the server renders them at request time with
[liquidjs](https://github.com/harttle/liquidjs) plus a mock Shopify layer:
schema settings get defaults/preset content, images use the bundled demo image,
icons use the bundled star asset, `settings_data.json` supplies the store's real theme settings,
and translations come from the theme locales. A final local-preview media pass
also replaces direct image fallbacks, lazy sources, posters, CSS media URLs, and
small icon SVGs, so newly added stores do not need per-theme patches. Each
preview loads the store's own CSS/JavaScript dependencies inside a sandboxed
iframe, so sections look and behave more like they do on the real store. Sections
depending on live store objects or Shopify editor block context show sample
data or are marked as context-dependent instead of being presented as fully
verified.

## Layout

```
src/ingest.js    scan stores/* → data/index.json (schemas, dependencies, quality)
src/section-meta.js shared schema/dependency analysis
src/renderer.js  liquidjs engine, Shopify mocks, filters & custom tags
src/exporter.js  ready-to-upload theme and lightweight section-pack ZIPs
src/server.js    API, preview routes, placeholder SVGs, custom section CRUD
public/          frontend (vanilla JS)
custom-sections/ your saved sections — standalone git repo
```

Supported stores live in `stores/<name>` (each a full theme export with
`sections/`, `snippets/`, `assets/`, `config/`, and `locales/`). Set
`STORES_ROOTS` to scan additional theme folders.
