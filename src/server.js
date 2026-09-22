// Section Library server: API + preview renderer + custom section storage (git-backed)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const express = require('express');
const { renderStoreSection, renderSectionSource, renderSnippet, findStore } = require('./renderer');

const ROOT = path.resolve(__dirname, '..');
const DATA_INDEX = path.join(ROOT, 'data/index.json');
const CUSTOM_DIR = path.join(ROOT, 'custom-sections');
const PORT = process.env.PORT || 4173;

fs.mkdirSync(CUSTOM_DIR, { recursive: true });

/* --------------------------------- git setup -------------------------------- */

function git(args) {
  return execFileSync('git', ['-c', 'user.name=section-library', '-c', 'user.email=library@local', ...args], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  }).toString().trim();
}
function gitInit() {
  try {
    if (!fs.existsSync(path.join(ROOT, '.git'))) {
      git(['init']);
      fs.appendFileSync(path.join(ROOT, '.git/info/exclude'), '\ncustom-sections/\n');
      git(['add', '-A']);
      git(['commit', '-m', 'Section library: initial commit (theme ingestion)'], );
    }
  } catch (e) { console.warn('git init skipped:', e.message.split('\n')[0]); }
}
function gitCommit(msg) {
  try {
    // custom sections are intentionally gitignored at the repo root (they may hold
    // proprietary theme code); they live in their own nested repo.
    if (!fs.existsSync(path.join(CUSTOM_DIR, '.git'))) {
      execFileSync('git', ['-c', 'user.name=section-library', '-c', 'user.email=library@local', 'init'], { cwd: CUSTOM_DIR });
    }
    execFileSync('git', ['-c', 'user.name=section-library', '-c', 'user.email=library@local', 'add', '-A'], { cwd: CUSTOM_DIR });
    const committed = execFileSync('git', ['-c', 'user.name=section-library', '-c', 'user.email=library@local',
      'commit', '-m', msg], { cwd: CUSTOM_DIR, stdio: ['ignore', 'pipe', 'ignore'] });
    return committed.status === 0;
  } catch { return false; } // nothing to commit
}

/* ------------------------------ custom sections ------------------------------ */

const slugify = (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'untitled';

function customSectionMeta(slug) {
  try { return JSON.parse(fs.readFileSync(path.join(CUSTOM_DIR, `${slug}.json`), 'utf8')); } catch { return null; }
}
function customSectionSources(slug) {
  let liquid = '', css = '', js = '';
  try { liquid = fs.readFileSync(path.join(CUSTOM_DIR, `${slug}.liquid`), 'utf8'); } catch {}
  const meta = customSectionMeta(slug);
  if (meta) { css = meta.css || ''; js = meta.js || ''; }
  return { liquid, css, js, meta };
}
function listCustomSections() {
  const out = [];
  for (const f of fs.readdirSync(CUSTOM_DIR)) {
    if (!f.endsWith('.json')) continue;
    const meta = customSectionMeta(f.replace(/\.json$/, ''));
    if (meta) out.push({ ...meta, store: 'custom', file: `${meta.slug}.liquid`, custom: true, functional: false, lines: (meta.liquid || '').split('\n').length });
  }
  return out;
}
function saveCustomSection(body, { isNew }) {
  const name = String(body.name || '').trim();
  if (!name) throw new Error('Name is required');
  let slug = slugify(name);
  if (isNew && fs.existsSync(path.join(CUSTOM_DIR, `${slug}.liquid`))) {
    slug = `${slug}-${Date.now().toString(36)}`;
  }
  const meta = {
    slug, name,
    category: body.category || 'Other',
    tags: Array.isArray(body.tags) ? body.tags : String(body.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
    contextStore: body.contextStore || 'custom',
    updatedAt: new Date().toISOString(),
    css: body.css || '', js: body.js || '',
  };
  fs.writeFileSync(path.join(CUSTOM_DIR, `${slug}.liquid`), body.liquid || '');
  fs.writeFileSync(path.join(CUSTOM_DIR, `${slug}.json`), JSON.stringify(meta, null, 2));
  gitCommit(`${isNew ? 'Add' : 'Update'} section: ${name}`);
  return meta;
}

/* --------------------------------- app setup --------------------------------- */

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(ROOT, 'public')));

function loadIndex() { return JSON.parse(fs.readFileSync(DATA_INDEX, 'utf8')); }

const STORE_CONFIG = path.join(ROOT, 'data/store-config.json');
const GALLERY_MANIFEST = path.join(ROOT, 'data/gallery-manifest.json');
const storeConfig = () => { try { return JSON.parse(fs.readFileSync(STORE_CONFIG, 'utf8')); } catch { return {}; } };
const galleryManifest = () => { try { return JSON.parse(fs.readFileSync(GALLERY_MANIFEST, 'utf8')); } catch { return {}; } };

/* ------------------------- live storefront auth/proxy ------------------------ */

const auth = { cookie: null, authedAt: 0 };

async function shopifyAuth() {
  const cfg = storeConfig();
  const base = cfg.storeUrl;
  const jar = [];
  const collect = (r) => { for (const c of (r.headers.getSetCookie?.() || [])) jar.push(c.split(';')[0]); };
  const r1 = await fetch(`${base}/password`, { redirect: 'manual' });
  collect(r1);
  const html = await r1.text();
  const token = (html.match(/name="authenticity_token" value="([^"]+)"/) || [])[1];
  const body = new URLSearchParams({ authenticity_token: token || '', password: cfg.storefrontPassword || '', form_type: 'storefront_password' });
  const r2 = await fetch(`${base}/password`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar.join('; '), Referer: `${base}/password` },
    body: body.toString(),
  });
  collect(r2);
  auth.cookie = jar.join('; ') || null;
  auth.authedAt = Date.now();
  return auth.cookie;
}

async function shopifyGet(url) {
  let r = await fetch(url, { headers: auth.cookie ? { Cookie: auth.cookie } : {}, redirect: 'manual' });
  const loc = r.headers.get('location') || '';
  if ((r.status === 302 && loc.includes('/password')) || r.status === 401 || r.status === 403) {
    await shopifyAuth();
    r = await fetch(url, { headers: auth.cookie ? { Cookie: auth.cookie } : {}, redirect: 'manual' });
  }
  return r;
}

app.get('/api/config', (req, res) => {
  const cfg = storeConfig();
  const live = !!(cfg.storeUrl && (cfg.previewThemeId || cfg.storefrontPassword));
  res.json({ livePreviews: live, storeUrl: cfg.storeUrl || null });
});

app.get('/api/index', (req, res) => {
  const idx = loadIndex();
  res.json({ ...idx, sections: [...idx.sections, ...listCustomSections()] });
});

app.get('/api/section/:store/:file', (req, res) => {
  const { store, file } = req.params;
  if (!/^[\w.-]+\.liquid$/.test(file)) return res.status(400).json({ error: 'bad file' });
  try {
    if (store === 'custom') {
      const meta = customSectionMeta(file.replace(/\.liquid$/, ''));
      if (!meta) return res.status(404).json({ error: 'not found' });
      const { liquid } = customSectionSources(meta.slug);
      return res.json({ meta: { ...meta, store: 'custom', file, custom: true }, liquid, css: meta.css || '', js: meta.js || '' });
    }
    const storePath = findStore(store);
    if (!storePath) return res.status(404).json({ error: 'not found' });
    const full = path.join(storePath, 'sections', file);
    const liquid = fs.readFileSync(full, 'utf8');
    const idx = loadIndex();
    const meta = idx.sections.find((s) => s.store === store && s.file === file) || {};
    const sm = liquid.match(/{%\s*schema\s*%}([\s\S]*?){%\s*endschema\s*%}/);
    let schema = null;
    if (sm) {
      try { schema = JSON.parse(sm[1]); } catch {}
      if (!schema) schema = require('./renderer').parseJsonLoose(sm[1]);
    }
    return res.json({ meta, liquid, css: '', js: '', schema });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ------------------------------- live render API ------------------------------ */

app.post('/api/render-preview', async (req, res) => {
  const { liquid = '', css = '', js = '', store = 'custom' } = req.body || {};
  const res2 = await renderSectionSource(store === 'custom' ? 'custom' : store, liquid, { sectionId: 'live-preview' });
  res.json(res2);
});

app.post('/api/custom', (req, res) => {
  try { res.json(saveCustomSection(req.body || {}, { isNew: true })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/custom/:slug', (req, res) => {
  try {
    const existing = customSectionMeta(req.params.slug);
    if (!existing) return res.status(404).json({ error: 'not found' });
    const meta = saveCustomSection({ ...req.body, name: req.body.name || existing.name }, { isNew: false });
    if (meta.slug !== req.params.slug) {
      // renamed — remove the old files
      for (const f of [`${req.params.slug}.liquid`, `${req.params.slug}.json`]) {
        try { fs.unlinkSync(path.join(CUSTOM_DIR, f)); } catch {}
      }
      gitCommit(`Rename section: ${existing.name} -> ${meta.name}`);
    }
    res.json(meta);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/custom/:slug', (req, res) => {
  const slug = req.params.slug;
  const meta = customSectionMeta(slug);
  if (!meta) return res.status(404).json({ error: 'not found' });
  for (const f of [`${slug}.liquid`, `${slug}.json`]) {
    try { fs.unlinkSync(path.join(CUSTOM_DIR, f)); } catch {}
  }
  gitCommit(`Delete section: ${meta.name}`);
  res.json({ ok: true });
});

/* ------------------------------- preview cache ------------------------------- */

const CACHE_DIR = path.join(ROOT, 'data/preview-cache');
const CACHE_TTL = 12 * 3600 * 1000; // 12h

function previewCacheGet(key) {
  const p = path.join(CACHE_DIR, key);
  try {
    if (Date.now() - fs.statSync(p).mtimeMs < CACHE_TTL) return fs.readFileSync(p, 'utf8');
    fs.unlinkSync(p);
  } catch {}
  return null;
}

function previewCacheSet(key, html) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, key), html);
  } catch {}
}

function previewCacheDelete(key) {
  try { fs.unlinkSync(path.join(CACHE_DIR, key)); } catch {}
}

/* --------------------------------- previews ---------------------------------- */

const RESET_CSS = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-size:16px;line-height:1.55;color:#1a1a1a;background:#fff;-webkit-font-smoothing:antialiased}
img,svg,video{max-width:100%;height:auto;display:block}
img{border-style:none}
a{color:inherit;text-decoration:none}
button,input,select,textarea{font:inherit;color:inherit;margin:0}
button{background:none;border:0;cursor:pointer;padding:0}
h1,h2,h3,h4,h5,h6,p,ul,ol,figure,blockquote{margin:0}
ul,ol{padding:0;list-style:none}
table{border-collapse:collapse;width:100%}
.placeholder-svg{width:100%;height:auto;background:#eceae5}
.preview-error{position:fixed;inset:auto 16px 16px 16px;z-index:9999;background:#7f1d1d;color:#fff;padding:14px 18px;border-radius:10px;font:14px/1.5 ui-monospace,monospace;white-space:pre-wrap;max-height:40vh;overflow:auto}
`;

function previewPage({ title, html, cssLinks = [], inlineCss = '', scripts = [], error = null, headExtra = '', externalScripts = [] }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>${RESET_CSS}</style>
${headExtra}
${cssLinks.map((h) => `<link rel="stylesheet" href="${h}">`).join('\n')}
${inlineCss ? `<style>${inlineCss}</style>` : ''}
</head>
<body>
${html}
${externalScripts.map((s) => `<script type="module" src="${s}"></script>`).join('\n')}
${scripts.map((s) => `<script>${s}</script>`).join('\n')}
${error ? `<div class="preview-error">Render error: ${String(error).replace(/</g, '&lt;')}</div>` : ''}
</body>
</html>`;
}

// Global CSS/JS the real storefront layout loads — sections rely on it for
// utility classes (.section-stack, .collection-card, ...) and design tokens.
const layoutDepsCache = new Map();
function getLayoutDeps(store) {
  if (layoutDepsCache.has(store)) return layoutDepsCache.get(store);
  const storePath = findStore(store);
  if (!storePath) return res.status(404).send('unknown store');
  const css = [], js = [];
  const scan = (text) => {
    let m;
    const cssRe = /['"]([\w./-]+\.css)['"]\s*\|\s*asset_url/g;
    while ((m = cssRe.exec(text))) if (!css.includes(m[1])) css.push(m[1]);
    const jsRe = /['"]([\w./-]+\.js)['"]\s*\|\s*asset_url/g;
    while ((m = jsRe.exec(text))) if (!js.includes(m[1])) js.push(m[1]);
  };
  let layoutSrc = '';
  try { layoutSrc = fs.readFileSync(path.join(storePath, 'layout/theme.liquid'), 'utf8'); scan(layoutSrc); } catch {}
  // Snippets rendered by the layout may carry the global assets (e.g. 'stylesheets').
  const snippetRe = /{%[-\s]*render\s+'([\w-]+)'/g;
  let m2;
  while ((m2 = snippetRe.exec(layoutSrc))) {
    try { scan(fs.readFileSync(path.join(storePath, 'snippets', `${m2[1]}.liquid`), 'utf8')); } catch {}
  }
  const deps = { css, js };
  layoutDepsCache.set(store, deps);
  return deps;
}

// Design tokens: the layout renders a css-variables snippet that defines the
// :root custom properties + @font-face rules theme.css depends on.
const headSnippetCache = new Map();
async function getLayoutHeadExtra(store) {
  if (headSnippetCache.has(store)) return headSnippetCache.get(store);
  let extra = '';
  for (const name of ['css-variables', 'css-vars', 'design-tokens']) {
    const out = await renderSnippet(store, name);
    if (out.trim()) { extra += out; break; }
  }
  headSnippetCache.set(store, extra);
  return extra;
}

app.get('/preview/:store/:file', async (req, res) => {
  const { store, file } = req.params;

  // When a gallery store is configured, previews render on real Shopify,
  // proxied through this server (authenticates with the storefront password).
  // Custom sections aren't in the manifest and keep the local mock renderer.
  const cfg = storeConfig();
  if (cfg.storeUrl && (cfg.previewThemeId || cfg.storefrontPassword)) {
    const entry = galleryManifest()[`${store}/${file}`];
    if (entry) {
      const params = new URLSearchParams({ view: entry.template });
      if (cfg.previewThemeId) params.set('preview_theme_id', cfg.previewThemeId);
      const target = `${cfg.storeUrl}/pages/${cfg.pageHandle}?${params}`;
      const key = crypto.createHash('md5').update(target).digest('hex');
      let cached = previewCacheGet(key);
      if (cached && /Liquid error/i.test(cached)) { previewCacheDelete(key); cached = null; }
      if (cached) return res.type('html').send(cached);
      const r = await shopifyGet(target);
      let html = await r.text();
      // sections that error live (missing product/blog refs etc.) render better
      // through the local mock — fall back instead of showing Shopify's error
      if (r.status === 200 && /Liquid error/i.test(html)) {
        const mock = await localPreview(req, res);
        return mock;
      }
      if (r.status === 200) previewCacheSet(key, html);
      else return localPreview(req, res); // not in the published theme yet — mock render
      return res.status(r.status).type('html').send(html);
    }
  }
  return localPreview(req, res);
});

async function localPreview(req, res) {
  const { store, file } = req.params;
  const storePath = findStore(store);
  if (store !== 'custom' && !storePath) return res.status(404).send('unknown store');
  try {
    if (store === 'custom') {
      if (!/^[\w.-]+(\.liquid)?$/.test(file)) return res.status(400).send('bad file');
      const slug = file.replace(/\.liquid$/, '');
      const meta = customSectionMeta(slug);
      if (!meta) return res.status(404).send('not found');
      const { liquid, css, js } = customSectionSources(slug);
      const r = await renderSectionSource(meta.contextStore === 'custom' ? 'custom' : meta.contextStore, liquid, { sectionId: slug });
      return res.type('html').send(previewPage({ title: meta.name, html: r.html, inlineCss: css, scripts: js ? [js] : [], error: r.error }));
    }
    if (!/^[\w.-]+\.liquid$/.test(file)) return res.status(400).send('bad file');
    const idx = loadIndex();
    const meta = idx.sections.find((s) => s.store === store && s.file === file);
    const r = await renderStoreSection(store, file);
    const deps = getLayoutDeps(store);
    const exists = (a) => fs.existsSync(path.join(storePath, 'assets', a));
    const cssLinks = [...new Set([...deps.css, ...(meta?.assets || []).filter((a) => a.endsWith('.css'))].filter(exists))]
      .map((a) => `/assets/${store}/${a}`);
    const sectionAssetJs = (meta?.assets || []).filter((a) => a.endsWith('.js') && exists(a) && !deps.js.includes(a));
    const scripts = [...r.js ? [r.js] : [], ...sectionAssetJs.map((a) => fs.readFileSync(path.join(storePath, 'assets', a), 'utf8'))];
    const externalScripts = deps.js.filter(exists).map((a) => `/assets/${store}/${a}`);
    const headExtra = await getLayoutHeadExtra(store);
    res.type('html').send(previewPage({ title: `${meta?.name || file} — ${store}`, html: r.html + (r.legacyCss ? `<style>${r.legacyCss}</style>` : ''), cssLinks, scripts, error: r.error, externalScripts, headExtra }));
  } catch (e) {
    res.status(500).type('html').send(previewPage({ title: 'error', html: '', error: e.message }));
  }
}

app.get('/reset.css', (req, res) => { res.type('css').send(RESET_CSS); });

/* ------------------------------ static assets/ph ------------------------------ */

app.use('/assets', (req, res, next) => {
  const parts = req.path.replace(/^\//, '').split('/');
  const store = decodeURIComponent(parts.shift() || '');
  const rel = parts.join('/');
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const storeRoot = findStore(store);
  if (!storeRoot) return res.status(404).end();
  const full = path.join(storeRoot, 'assets', safe);
  if (!full.startsWith(storeRoot)) return res.status(403).end();
  res.sendFile(full, (e) => { if (e) res.status(404).end(); });
});

app.get('/ph/:seed/:dims.svg', (req, res) => {
  const { seed, dims } = req.params;
  const [w, h] = dims.split('x').map((n) => Math.min(parseInt(n) || 600, 4000));
  let hash = 0;
  for (const c of seed) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  const hue2 = (hue + 40) % 360;
  const label = seed.replace(/[-_]+/g, ' ').slice(0, 40);
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(
`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid slice">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="hsl(${hue},22%,86%)"/><stop offset="1" stop-color="hsl(${hue2},18%,74%)"/>
</linearGradient></defs>
<rect width="${w}" height="${h}" fill="url(#g)"/>
<rect x="${w * 0.35}" y="${h * 0.38}" width="${w * 0.3}" height="${h * 0.3}" rx="10" fill="hsl(${hue},14%,64%)"/>
<text x="${w / 2}" y="${h * 0.82}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="${Math.max(14, Math.round(w / 42))}" fill="hsl(${hue},12%,38%)">${label.replace(/[<>&]/g, '')}</text>
</svg>`);
});

/* --------------------------------- fallback ---------------------------------- */

app.use((req, res) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/') && !req.path.startsWith('/preview/')) {
    return res.sendFile(path.join(ROOT, 'public/index.html'));
  }
  res.status(404).json({ error: 'not found' });
});

gitInit();
app.listen(PORT, () => console.log(`Section Library → http://localhost:${PORT}`));
