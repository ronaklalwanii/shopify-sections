// Section Library server: API + preview renderer + custom section storage (git-backed)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const express = require('express');
const { renderStoreSection, renderSectionSource, renderSnippet, renderLayoutTokens, layoutTokensFallback, isEsmJs, findStore, getEngine, googleFontsLink } = require('./renderer');
const { extractSchema, collectSectionDependencies, extractAssetRefs, extractSnippetRefs, normalizeAssetName } = require('./section-meta');
const { buildExport } = require('./exporter');
const { CUSTOM_SLUG, assertCustomSlug, customFilePath } = require('./path-safety');

const ROOT = path.resolve(__dirname, '..');
const IS_SERVERLESS = !!process.env.VERCEL;
// Serverless filesystems are ephemeral: only /tmp is writable.
const WRITABLE_DIR = process.env.DATA_DIR || (IS_SERVERLESS ? '/tmp/sl-data' : ROOT);
const DATA_DIR = path.join(WRITABLE_DIR, 'data');
const DATA_INDEX = path.join(ROOT, 'data', 'index.json');
const GALLERY_MANIFEST = path.join(ROOT, 'data', 'gallery-manifest.json');
const STORE_CONFIG = path.join(ROOT, 'data', 'store-config.json');
const CUSTOM_DIR = process.env.CUSTOM_DIR || (IS_SERVERLESS ? '/tmp/sl-custom' : path.join(ROOT, 'custom-sections'));
const PORT = process.env.PORT || 4173;

fs.mkdirSync(CUSTOM_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

// secrets come from env on the server; the local json file is a dev fallback
const storeConfig = () => {
  const fileCfg = (() => { try { return JSON.parse(fs.readFileSync(STORE_CONFIG, 'utf8')); } catch { return {}; } })();
  return {
    ...fileCfg,
    storeUrl: process.env.STORE_URL || fileCfg.storeUrl,
    previewThemeId: process.env.PREVIEW_THEME_ID || fileCfg.previewThemeId || '',
    storefrontPassword: process.env.STOREFRONT_PASSWORD || fileCfg.storefrontPassword || '',
    pageHandle: process.env.PAGE_HANDLE || fileCfg.pageHandle || 'section-library',
  };
};

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
function gitCommit(msg, { requireRemote = false } = {}) {
  try {
    if (!fs.existsSync(path.join(CUSTOM_DIR, '.git'))) {
      execFileSync('git', ['-c', 'user.name=section-library', '-c', 'user.email=library@local', 'init'], { cwd: CUSTOM_DIR });
    }
    execFileSync('git', ['-c', 'user.name=section-library', '-c', 'user.email=library@local', 'add', '-A'], { cwd: CUSTOM_DIR });
    try {
      execFileSync('git', ['-c', 'user.name=section-library', '-c', 'user.email=library@local', 'commit', '-m', msg], {
        cwd: CUSTOM_DIR, stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (error) {
      if (!/nothing to commit/i.test(String(error.stderr || error.message))) throw error;
    }
    if (process.env.DATA_REPO && process.env.DATA_TOKEN) {
      const url = `https://x-access-token:${process.env.DATA_TOKEN}@${process.env.DATA_REPO}.git`;
      try { execFileSync('git', ['remote', 'add', 'origin', url], { cwd: CUSTOM_DIR, stdio: 'ignore' }); } catch {}
      execFileSync('git', ['push', '-u', 'origin', 'HEAD'], { cwd: CUSTOM_DIR, stdio: 'ignore' });
    }
    return true;
  } catch (error) {
    if (requireRemote) throw error;
    console.warn('Custom section git commit failed:', String(error.message || error).split('\n')[0]);
    return false;
  }
}

// On serverless, persist saved sections through the GitHub Contents API
// (no git binary available): DATA_REPO="owner/repo" + DATA_TOKEN.
const GH_DATA = (process.env.DATA_REPO && process.env.DATA_TOKEN)
  ? { repo: process.env.DATA_REPO, token: process.env.DATA_TOKEN } : null;

async function ghReq(path, opts = {}) {
  return fetch(`https://api.github.com/repos/${GH_DATA.repo}/contents/${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${GH_DATA.token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'section-library',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {}),
    },
  });
}

async function ghRestore() {
  if (!GH_DATA) return false;
  const response = await ghReq('custom-sections');
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`GitHub restore failed (${response.status})`);
  const items = await response.json();
  const remoteSlugs = new Set();
  for (const item of items.filter((entry) => entry.type === 'file')) {
    const file = await ghReq(`custom-sections/${item.name}`);
    if (!file.ok) throw new Error(`GitHub restore failed for ${item.name} (${file.status})`);
    const data = await file.json();
    const slug = item.name.replace(/\.(?:json|liquid)$/, '');
    const extension = item.name.endsWith('.liquid') ? 'liquid' : item.name.endsWith('.json') ? 'json' : null;
    if (extension && CUSTOM_SLUG.test(slug)) {
      remoteSlugs.add(slug);
      fs.writeFileSync(customPath(slug, extension), Buffer.from(data.content, 'base64'));
    }
  }
  for (const file of fs.readdirSync(CUSTOM_DIR)) {
    const match = file.match(/^([\w-]+)\.(?:json|liquid)$/);
    if (match && !remoteSlugs.has(match[1])) removeCustomFiles(match[1]);
  }
  console.log(`gh restore: ${items.length} files restored`);
  return true;
}

let ghRestoreInFlight = null;
let lastGhRestoreAt = 0;
let customSectionsRestoreError = null;

async function refreshCustomSections({ maxAgeMs = 0 } = {}) {
  if (!GH_DATA) return false;
  if (maxAgeMs && Date.now() - lastGhRestoreAt < maxAgeMs) return true;
  if (!ghRestoreInFlight) {
    ghRestoreInFlight = ghRestore()
      .then((result) => { lastGhRestoreAt = Date.now(); customSectionsRestoreError = null; return result; })
      .catch((error) => { lastGhRestoreAt = Date.now(); throw error; })
      .finally(() => { ghRestoreInFlight = null; });
  }
  return ghRestoreInFlight;
}

async function ensureCustomSectionRemote(slug) {
  if (!GH_DATA || !CUSTOM_SLUG.test(slug)) return false;
  try {
    if (fs.readFileSync(customPath(slug, 'liquid'), 'utf8').trim() && fs.existsSync(customPath(slug, 'json'))) return true;
  } catch {}
  try {
    const [liquidResponse, jsonResponse] = await Promise.all([
      ghReq(`custom-sections/${slug}.liquid`),
      ghReq(`custom-sections/${slug}.json`),
    ]);
    if (!liquidResponse.ok || !jsonResponse.ok) return false;
    const [liquidData, jsonData] = await Promise.all([liquidResponse.json(), jsonResponse.json()]);
    const liquid = Buffer.from(liquidData.content || '', 'base64').toString('utf8');
    const json = Buffer.from(jsonData.content || '', 'base64').toString('utf8');
    if (!liquid.trim() || !json.trim()) return false;
    writeCustomFiles(slug, liquid, json);
    return true;
  } catch {
    return false;
  }
}

async function ghPersistFile(name, contentStr) {
  if (!GH_DATA) return true;
  const existing = await ghReq(`custom-sections/${name}`);
  if (!existing.ok && existing.status !== 404) throw new Error(`GitHub lookup failed (${existing.status})`);
  const sha = existing.ok ? (await existing.json()).sha : undefined;
  const saved = await ghReq(`custom-sections/${name}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: `section-library: save ${name}`,
      content: Buffer.from(contentStr, 'utf8').toString('base64'),
      ...(sha ? { sha } : {}),
    }),
  });
  if (!saved.ok) throw new Error(`GitHub save failed (${saved.status})`);
  return true;
}

async function ghDeleteFile(name) {
  if (!GH_DATA) return true;
  const existing = await ghReq(`custom-sections/${name}`);
  if (existing.status === 404) return true;
  if (!existing.ok) throw new Error(`GitHub lookup failed (${existing.status})`);
  const sha = (await existing.json()).sha;
  const deleted = await ghReq(`custom-sections/${name}`, {
    method: 'DELETE',
    body: JSON.stringify({ message: `section-library: delete ${name}`, sha }),
  });
  if (!deleted.ok) throw new Error(`GitHub delete failed (${deleted.status})`);
  return true;
}

function describePersistenceError(error) {
  const message = String(error?.message || error || 'Custom section persistence failed');
  if (/\b403\b/.test(message)) return `${message}. Check that DATA_REPO is accessible and DATA_TOKEN has Contents: read and write permission.`;
  return message;
}

async function persistCustomSectionRemote({ meta, liquid, json }, { rollbackCreated = false } = {}) {
  if (!GH_DATA) return;
  const files = [[`${meta.slug}.liquid`, liquid], [`${meta.slug}.json`, json]];
  const written = [];
  try {
    for (const [name, content] of files) {
      await ghPersistFile(name, content);
      written.push(name);
    }
  } catch (error) {
    if (rollbackCreated) {
      for (const name of written) {
        try { await ghDeleteFile(name); } catch {}
      }
    }
    throw new Error(describePersistenceError(error));
  }
}

// On boot, restore saved custom sections from the GitHub data repo if configured.
function initDataRepo() {
  if (!process.env.DATA_REPO || !process.env.DATA_TOKEN) return;
  const url = `https://x-access-token:${process.env.DATA_TOKEN}@${process.env.DATA_REPO}.git`;
  try {
    if (fs.existsSync(path.join(CUSTOM_DIR, '.git'))) {
      execFileSync('git', ['pull'], { cwd: CUSTOM_DIR, stdio: 'ignore' });
    } else if (fs.readdirSync(CUSTOM_DIR).length === 0) {
      execFileSync('git', ['clone', url, '.'], { cwd: CUSTOM_DIR, stdio: 'ignore' });
    } else {
      execFileSync('git', ['init'], { cwd: CUSTOM_DIR, stdio: 'ignore' });
      execFileSync('git', ['remote', 'add', 'origin', url], { cwd: CUSTOM_DIR, stdio: 'ignore' });
      try { execFileSync('git', ['pull', 'origin', 'HEAD'], { cwd: CUSTOM_DIR, stdio: 'ignore' }); } catch {}
    }
    const nested = path.join(CUSTOM_DIR, 'custom-sections');
    if (fs.existsSync(nested)) {
      let collision = false;
      for (const entry of fs.readdirSync(nested)) {
        if (entry === '.git') continue;
        const source = path.join(nested, entry);
        const destination = path.join(CUSTOM_DIR, entry);
        if (!fs.existsSync(destination)) fs.renameSync(source, destination);
        else collision = true;
      }
      if (!collision) fs.rmSync(nested, { recursive: true, force: true });
    }
    console.log('Custom sections restored from data repo');
  } catch (e) {
    console.warn('Data repo restore skipped:', String(e.message || e).split('\n')[0]);
  }
}

/* ------------------------------ custom sections ------------------------------ */

function customPath(slug, extension) {
  return customFilePath(CUSTOM_DIR, slug, extension);
}

const slugify = (value) => String(value).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '').slice(0, 80).replace(/-+$/g, '') || 'untitled';

function customSectionMeta(slug) {
  try { return JSON.parse(fs.readFileSync(customPath(slug, 'json'), 'utf8')); } catch { return null; }
}

function customSectionSources(slug) {
  let liquid = '', css = '', js = '';
  try { liquid = fs.readFileSync(customPath(slug, 'liquid'), 'utf8'); } catch {}
  const meta = customSectionMeta(slug);
  if (meta) { css = meta.css || ''; js = meta.js || ''; }
  return { liquid, css, js, meta };
}

function writeCustomFiles(slug, liquid, json) {
  const liquidPath = customPath(slug, 'liquid');
  const jsonPath = customPath(slug, 'json');
  const nonce = crypto.randomBytes(6).toString('hex');
  const liquidTemp = `${liquidPath}.${nonce}.tmp`;
  const jsonTemp = `${jsonPath}.${nonce}.tmp`;
  try {
    fs.writeFileSync(liquidTemp, liquid);
    fs.writeFileSync(jsonTemp, json);
    fs.renameSync(liquidTemp, liquidPath);
    fs.renameSync(jsonTemp, jsonPath);
  } catch (error) {
    try { fs.unlinkSync(liquidTemp); } catch {}
    try { fs.unlinkSync(jsonTemp); } catch {}
    throw error;
  }
}

function removeCustomFiles(slug) {
  for (const extension of ['liquid', 'json']) {
    try { fs.unlinkSync(customPath(slug, extension)); } catch {}
  }
}

function snapshotCustomFiles(slug) {
  const snapshot = {};
  for (const extension of ['liquid', 'json']) {
    try { snapshot[extension] = fs.readFileSync(customPath(slug, extension), 'utf8'); } catch {}
  }
  return snapshot;
}

function restoreCustomFiles(slug, snapshot) {
  removeCustomFiles(slug);
  for (const extension of ['liquid', 'json']) {
    if (snapshot[extension] != null) fs.writeFileSync(customPath(slug, extension), snapshot[extension]);
  }
}

function listCustomSections() {
  const out = [];
  for (const file of fs.readdirSync(CUSTOM_DIR)) {
    if (!file.endsWith('.json')) continue;
    const slug = file.replace(/\.json$/, '');
    if (!CUSTOM_SLUG.test(slug)) continue;
    const meta = customSectionMeta(slug);
    if (!meta) continue;
    const { liquid } = customSectionSources(slug);
    if (!liquid.trim()) continue;
    const schema = extractSchema(liquid);
    out.push({
      ...meta, slug, store: 'custom', file: `${slug}.liquid`, custom: true, functional: false,
      lines: liquid.split('\n').length, settings: schema?.settings?.length || 0, blocks: schema?.blocks?.length || 0,
      hasSchema: !!schema, schemaStatus: schema ? 'valid' : /{%-?\s*schema\s*-?%}/i.test(liquid) ? 'invalid' : 'missing',
      dependencies: { snippets: [], assets: [], missingSnippets: [], missingAssets: [] },
      quality: { status: 'unverified', issues: [], checkedAt: null }, linesKnown: true,
    });
  }
  return out;
}

function saveCustomSection(body, { isNew, previousSlug = null }) {
  const name = String(body.name || '').trim();
  if (!name) throw new Error('Name is required');
  const liquid = String(body.liquid || '');
  if (!liquid.trim()) throw new Error('Liquid is required');
  const slug = slugify(name);
  if (fs.existsSync(customPath(slug, 'liquid')) && slug !== previousSlug) throw new Error('A section with this name already exists');
  const contextStore = body.contextStore || 'custom';
  if (contextStore !== 'custom' && !findStore(contextStore)) throw new Error('Invalid preview context');
  const tags = (Array.isArray(body.tags) ? body.tags : String(body.tags || '').split(','))
    .map((tag) => String(tag).trim()).filter(Boolean).slice(0, 20);
  const meta = {
    slug, name,
    category: String(body.category || 'Other').slice(0, 80),
    tags,
    contextStore,
    updatedAt: new Date().toISOString(),
    css: String(body.css || ''), js: String(body.js || ''),
  };
  const json = JSON.stringify(meta, null, 2);
  writeCustomFiles(slug, liquid, json);
  return { meta, json, liquid };
}

/* --------------------------------- app setup --------------------------------- */

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  next();
});

/* ------------------------------ team access gate ------------------------------ */

const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || '';
if (process.env.NODE_ENV === 'production' && !ACCESS_PASSWORD) {
  throw new Error('ACCESS_PASSWORD is required when NODE_ENV=production');
}
const authCookieValue = () =>
  crypto.createHmac('sha256', ACCESS_PASSWORD).update('section-library-access').digest('hex');
const hasAuthCookie = (header) => String(header || '').split(';')
  .map((part) => part.trim()).some((part) => part === `sl_auth=${authCookieValue()}`);
const PREVIEW_TOKEN_SECRET = process.env.PREVIEW_TOKEN_SECRET || ACCESS_PASSWORD || 'section-library-preview-local';
const PREVIEW_TOKEN_TTL = 60 * 60 * 1000;
const previewTokenSignature = (expires) => crypto.createHmac('sha256', PREVIEW_TOKEN_SECRET).update(String(expires)).digest('hex');
function createPreviewToken() {
  // Bucket the expiry so every preview in a window shares one token. A per-request
  // timestamp made each asset URL unique, which defeated browser caching and forced
  // every card to re-download the same multi-hundred-KB assets.
  const expires = Math.ceil((Date.now() + 1) / PREVIEW_TOKEN_TTL) * PREVIEW_TOKEN_TTL;
  return `${expires}.${previewTokenSignature(expires)}`;
}
function verifyPreviewToken(token) {
  const [expires, signature] = String(token || '').split('.');
  const expiry = Number(expires);
  if (!Number.isSafeInteger(expiry) || expiry <= Date.now() || !signature) return false;
  const expected = Buffer.from(previewTokenSignature(expires), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
const hasPreviewCookie = (header) => String(header || '').split(';')
  .map((part) => part.trim()).some((part) => part.startsWith('sl_preview=') && verifyPreviewToken(part.slice('sl_preview='.length)));

// Our own placeholder assets hold no merchant content and /assets serves them
// without a token, so they keep a stable URL and stay cacheable across sessions.
const PUBLIC_PREVIEW_ASSET_RE = /^\/assets\/(?:demo-image\.jpg|star\.svg)(?:[?#]|$)/i;

function previewAssetToken(url, token) {
  const value = String(url || '');
  if (!/^\/assets\//i.test(value)) return value;
  if (PUBLIC_PREVIEW_ASSET_RE.test(value)) return value.replace(/[?#].*$/, '');
  try {
    const parsed = new URL(value, 'http://preview.local');
    if (parsed.searchParams.get('sl_preview') === token) return value;
    parsed.searchParams.set('sl_preview', token);
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch { return value; }
}

function tokenizePreviewAssets(value, token) {
  return String(value || '').replace(/(^|["'(=\s])\/assets\/[^\s"'<>)]+/gi, (match, prefix) => prefix + previewAssetToken(match.slice(prefix.length), token));
}

function hasPreviewAssetToken(req) {
  return req.path.startsWith('/assets/') && verifyPreviewToken(req.query.sl_preview);
}

function loginPage(msg = '') {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Section Library — sign in</title>
<style>body{margin:0;font:14px/1.5 system-ui,sans-serif;background:#16171a;color:#c9cbd1;display:grid;place-items:center;min-height:100vh}
.box{background:#222327;padding:34px 38px;border-radius:14px;width:300px}
h1{font-size:16px;color:#fff;margin:0 0 4px}p{margin:0 0 18px;font-size:12px;color:#7e8189}
input{width:100%;box-sizing:border-box;background:#16171a;border:1px solid #313338;color:#e8e9ec;border-radius:8px;padding:10px 12px;font:inherit;outline:none;margin-bottom:12px}
button{width:100%;background:#2f6f4f;color:#fff;border:0;border-radius:8px;padding:10px;font:inherit;font-weight:600;cursor:pointer}
.err{color:#e08a80;font-size:12px;margin:-6px 0 12px}</style></head>
<body><div class="box"><h1>Section Library</h1><p>Team access</p>
${msg ? `<div class="err">${msg}</div>` : ''}
<form method="post" action="/login"><input type="password" name="password" placeholder="Access password" autofocus><button>Sign in</button></form>
</div></body></html>`;
}

function isPreviewAssetRequest(req) {
  if (!req.path.startsWith('/assets/')) return false;
  const referer = req.get('referer');
  if (!referer) return false;
  try {
    const url = new URL(referer);
    const host = req.get('x-forwarded-host') || req.get('host');
    return url.host === host && (url.pathname.startsWith('/preview/') || url.pathname.startsWith('/assets/'));
  } catch { return false; }
}

app.use((req, res, next) => {
  if (!ACCESS_PASSWORD) return next();
  if (req.path === '/login') return next();
  if (hasAuthCookie(req.headers.cookie)) return next();
  if (isPreviewAssetRequest(req) || hasPreviewAssetToken(req) || PUBLIC_PREVIEW_ASSET_RE.test(req.path) || (req.path.startsWith('/assets/') && hasPreviewCookie(req.headers.cookie))) return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/preview/')) return res.status(401).json({ error: 'unauthorized' });
  res.status(401).type('html').send(loginPage());
});

const loginAttempts = new Map();
function loginBlocked(ip) {
  const now = Date.now();
  const recent = (loginAttempts.get(ip) || []).filter((time) => now - time < 15 * 60 * 1000);
  if (recent.length >= 10) {
    loginAttempts.set(ip, recent);
    return true;
  }
  loginAttempts.set(ip, recent);
  return false;
}

app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  if (loginBlocked(req.ip)) return res.status(429).type('html').send(loginPage('Too many attempts. Try again later.'));
  if (req.body.password === ACCESS_PASSWORD) {
    loginAttempts.delete(req.ip);
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `sl_auth=${authCookieValue()}; Path=/; HttpOnly; Max-Age=2592000; SameSite=Lax${secure}`);
    res.redirect('/');
  } else {
    const attempts = loginAttempts.get(req.ip) || [];
    attempts.push(Date.now());
    loginAttempts.set(req.ip, attempts);
    res.status(401).type('html').send(loginPage('Wrong password — try again.'));
  }
});
app.use(express.json({ limit: '4mb' }));

// Cold-start gate: restore persisted custom sections before the first request.
const bootReady = IS_SERVERLESS
  ? refreshCustomSections().catch((error) => {
    customSectionsRestoreError = error;
    console.error('Custom section restore failed:', error.message);
    return false;
  })
  : Promise.resolve();
if (IS_SERVERLESS) app.use((req, res, next) => {
  bootReady.then(() => next());
});

app.use(express.static(path.join(ROOT, 'public')));

let indexCache = null;
function loadIndex() {
  if (!indexCache) indexCache = JSON.parse(fs.readFileSync(DATA_INDEX, 'utf8'));
  return indexCache;
}

let galleryManifestCache = null;
const galleryManifest = () => {
  if (!galleryManifestCache) {
    try { galleryManifestCache = JSON.parse(fs.readFileSync(GALLERY_MANIFEST, 'utf8')); }
    catch { galleryManifestCache = {}; }
  }
  return galleryManifestCache;
};

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
  const live = process.env.LIVE_PREVIEWS === '1' && !!(cfg.storeUrl && (cfg.previewThemeId || cfg.storefrontPassword));
  res.json({
    livePreviews: live,
    storeUrl: cfg.storeUrl || null,
    commit: process.env.VERCEL_GIT_COMMIT_SHA ? process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7) : 'local',
  });
});

app.get('/api/index', async (req, res) => {
  if (IS_SERVERLESS && GH_DATA) {
    try { await refreshCustomSections({ maxAgeMs: 15000 }); }
    catch (error) {
      customSectionsRestoreError = error;
      console.warn('Custom section refresh skipped:', error.message);
    }
  }
  res.set('Cache-Control', 'no-store');
  const idx = loadIndex();
  res.json({ ...idx, sections: [...idx.sections, ...listCustomSections()] });
});

app.get('/api/section/:store/:file', async (req, res) => {
  const { store, file } = req.params;
  if (!/^[\w.-]+\.liquid$/.test(file)) return res.status(400).json({ error: 'bad file' });
  try {
    if (store === 'custom') {
      const slug = file.replace(/\.liquid$/, '');
      assertCustomSlug(slug);
      await ensureCustomSectionRemote(slug);
      const sources = customSectionSources(slug);
      if (!sources.meta || !sources.liquid.trim()) {
        if (customSectionsRestoreError) return res.status(503).json({ error: `Custom sections unavailable: ${customSectionsRestoreError.message}` });
        return res.status(404).json({ error: 'not found' });
      }
      const contextPath = sources.meta.contextStore === 'custom' ? null : findStore(sources.meta.contextStore);
      const dependencies = contextPath
        ? collectSectionDependencies(contextPath, sources.liquid)
        : { snippets: extractSnippetRefs(sources.liquid), assets: extractAssetRefs(sources.liquid), missingSnippets: extractSnippetRefs(sources.liquid), missingAssets: extractAssetRefs(sources.liquid) };
      return res.json({
        meta: { ...sources.meta, slug, store: 'custom', file, custom: true },
        liquid: sources.liquid, css: sources.css, js: sources.js,
        schema: extractSchema(sources.liquid), dependencies,
      });
    }
    const storePath = findStore(store);
    if (!storePath) return res.status(404).json({ error: 'not found' });
    const sectionsRoot = path.join(storePath, 'sections');
    const full = path.join(sectionsRoot, file);
    if (path.dirname(full) !== sectionsRoot) return res.status(400).json({ error: 'bad file' });
    const liquid = fs.readFileSync(full, 'utf8');
    const meta = loadIndex().sections.find((section) => section.store === store && section.file === file) || {};
    return res.json({ meta, liquid, css: '', js: '', schema: extractSchema(liquid), dependencies: collectSectionDependencies(storePath, liquid) });
  } catch (error) {
    res.status(/Invalid/.test(error.message) ? 400 : 500).json({ error: error.message });
  }
});

/* ------------------------------- live render API ------------------------------ */

app.post('/api/render-preview', async (req, res) => {
  const { liquid = '', css = '', js = '', store = 'custom' } = req.body || {};
  const res2 = await renderSectionSource(store === 'custom' ? 'custom' : store, liquid, { sectionId: 'live-preview' });
  const token = createPreviewToken();
  res.json({ ...res2, html: tokenizePreviewAssets(normalizePreviewMedia(res2.html), token) });
});

app.post('/api/export', async (req, res) => {
  try {
    const body = req.body || {};
    const name = String(body.name || 'section-pack').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'section-pack';
    const result = buildExport({
      items: body.items,
      mode: body.mode,
      baseStore: body.baseStore || 'base',
      name,
      customDir: CUSTOM_DIR,
      sourceCommit: process.env.VERCEL_GIT_COMMIT_SHA || null,
    });
    const maxBytes = IS_SERVERLESS ? 4.5 * 1024 * 1024 : 0;
    if (maxBytes && result.buffer.length > maxBytes) throw new Error('This export is too large for the deployment. Select fewer sections or use the lightweight pack.');
    const suffix = body.mode === 'pack' ? 'sections' : 'theme';
    res.set('Cache-Control', 'no-store');
    res.set('Content-Disposition', `attachment; filename="${name}-${suffix}.zip"`);
    res.type('application/zip');
    res.send(result.buffer);
  } catch (error) {
    res.status(400).json({ error: error.message || 'Export failed' });
  }
});

app.post('/api/custom', async (req, res) => {
  let saved;
  try {
    saved = saveCustomSection(req.body || {}, { isNew: true });
    await persistCustomSectionRemote(saved, { rollbackCreated: true });
    if (!IS_SERVERLESS) gitCommit(`Add section: ${saved.meta.name}`);
    res.json(saved.meta);
  } catch (error) {
    if (saved?.meta?.slug) removeCustomFiles(saved.meta.slug);
    const status = /GitHub|persistence|Contents: read/i.test(String(error.message || error)) ? 502 : 400;
    res.status(status).json({ error: error.message });
  }
});

app.put('/api/custom/:slug', async (req, res) => {
  let saved;
  let previousSlug;
  let snapshot;
  try {
    previousSlug = assertCustomSlug(req.params.slug);
    const existing = customSectionMeta(previousSlug);
    if (!existing) return res.status(404).json({ error: 'not found' });
    snapshot = snapshotCustomFiles(previousSlug);
    saved = saveCustomSection(
      { ...req.body, name: req.body.name || existing.name },
      { isNew: false, previousSlug },
    );
    await persistCustomSectionRemote(saved);
    if (saved.meta.slug !== previousSlug) {
      for (const file of [`${previousSlug}.liquid`, `${previousSlug}.json`]) {
        const extension = file.endsWith('.liquid') ? 'liquid' : 'json';
        try { fs.unlinkSync(customPath(previousSlug, extension)); } catch {}
        await ghDeleteFile(file);
      }
    }
    if (!IS_SERVERLESS) gitCommit(saved.meta.slug !== previousSlug ? `Rename section: ${existing.name} -> ${saved.meta.name}` : `Update section: ${saved.meta.name}`);
    res.json(saved.meta);
  } catch (error) {
    if (saved?.meta?.slug && saved.meta.slug !== previousSlug) removeCustomFiles(saved.meta.slug);
    if (previousSlug && snapshot) restoreCustomFiles(previousSlug, snapshot);
    const status = /Invalid|required|already exists|not found/i.test(error.message) ? 400 : (/GitHub|persistence|Contents: read/i.test(String(error.message || error)) ? 502 : 500);
    res.status(status).json({ error: error.message });
  }
});

app.delete('/api/custom/:slug', async (req, res) => {
  try {
    const slug = assertCustomSlug(req.params.slug);
    const meta = customSectionMeta(slug);
    if (!meta && !GH_DATA) return res.status(404).json({ error: 'not found' });
    for (const file of [`${slug}.liquid`, `${slug}.json`]) {
      const extension = file.endsWith('.liquid') ? 'liquid' : 'json';
      try { fs.unlinkSync(customPath(slug, extension)); } catch {}
      await ghDeleteFile(file);
    }
    if (meta && !IS_SERVERLESS) gitCommit(`Delete section: ${meta.name}`);
    res.json({ ok: true });
  } catch (error) {
    res.status(/Invalid/.test(error.message) ? 400 : 500).json({ error: error.message });
  }
});

/* ------------------------------- preview cache ------------------------------- */

const CACHE_DIR = path.join(WRITABLE_DIR, 'data', 'preview-cache');
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

// Theme JS (and the third-party CDN bundles it imports) is written for full
// storefronts, not sandboxed preview iframes: bare `exports` / `require` /
// `module` references throw ReferenceErrors and kill the whole module graph,
// surfacing as red console errors on otherwise fine previews. This inert shim
// runs first so foreign bundles degrade to no-ops instead of throwing.
const CJS_SHIM = `<script>window.exports=window.exports||{};window.module=window.module||{exports:window.exports};window.require=window.require||function(){return{}};</script>`;

const RESET_CSS = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;background:#fff}
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

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function hasVisiblePreview(html) {
  const markup = String(html || '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  const text = markup.replace(/<[^>]+>/g, ' ').replace(/&(?:nbsp|amp|lt|gt|quot|#39);/gi, ' ').replace(/\s+/g, ' ').trim();
  return !!(text || /<(?:img|svg|video|picture|source|hr|input)\b/i.test(html) || /url\(/i.test(html) || /class=["'][^"']*\bdivider(?:__|--|\b)/i.test(html));
}

function previewPage({ title, html, cssLinks = [], inlineCss = '', scripts = [], error = null, headExtra = '', externalScripts = [] }) {
  const previewToken = createPreviewToken();
  const externalTag = (script) => {
    const src = typeof script === 'string' ? script : script.src;
    const href = escapeHtml(previewAssetToken(src, previewToken));
    return typeof script === 'string' || script.esm
      ? `<script type="module" src="${href}"></script>`
      : `<script src="${href}" defer></script>`;
  };
  const stylesheetTag = (href) => `<link rel="stylesheet" href="${escapeHtml(previewAssetToken(href, previewToken))}">`;
  const inlineStyle = String(inlineCss || '').replace(/<\/style/gi, '<\\/style');
  const inlineScripts = scripts.map((script) => tokenizePreviewAssets(String(script).replace(/<\/script/gi, '<\\/script'), previewToken));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
${CJS_SHIM}
<style>${RESET_CSS}</style>
${tokenizePreviewAssets(normalizePreviewMedia(headExtra), previewToken)}
${cssLinks.map(stylesheetTag).join('\n')}
${inlineCss ? `<style>${normalizeCssUrls(inlineStyle, 'inline style', previewToken)}</style>` : ''}
</head>
<body>
${tokenizePreviewAssets(normalizePreviewMedia(html), previewToken)}
${externalScripts.map(externalTag).join('\n')}
${inlineScripts.map((script) => `<script>${script}</script>`).join('\n')}
${error ? `<div class="preview-error">Render error: ${escapeHtml(error)}</div>` : ''}
</body>
</html>`;
}

// Global CSS/JS the real storefront layout loads — sections rely on it for
// utility classes (.section-stack, .collection-card, ...) and design tokens.
const layoutDepsCache = new Map();
function getLayoutDeps(store) {
  if (layoutDepsCache.has(store)) return layoutDepsCache.get(store);
  const storePath = findStore(store);
  if (!storePath) return { css: [], js: [] };
  const css = [], js = [];
  const scan = (text) => {
    let m;
    const filters = '(?:asset_url|shopify_asset_url|inline_asset_content|stylesheet_tag|script_tag|preload_tag)';
    const cssRe = new RegExp(`['"]([\\w./-]+\\.css)['"]\\s*\\|\\s*${filters}`, 'g');
    const jsRe = new RegExp(`['"]([\\w./-]+\\.m?js)['"]\\s*\\|\\s*${filters}`, 'g');
    const add = (list, value) => {
      const name = normalizeAssetName(value);
      if (name && !name.split('/').includes('..') && !list.includes(name)) list.push(name);
    };
    while ((m = cssRe.exec(text))) add(css, m[1]);
    while ((m = jsRe.exec(text))) add(js, m[1]);
  };
  let layoutSrc = '';
  try { layoutSrc = fs.readFileSync(path.join(storePath, 'layout/theme.liquid'), 'utf8'); scan(layoutSrc); } catch {}
  // Snippets rendered by the layout may carry the global assets (e.g. 'stylesheets').
  for (const name of extractSnippetRefs(layoutSrc)) {
    try { scan(fs.readFileSync(path.join(storePath, 'snippets', `${name}.liquid`), 'utf8')); } catch {}
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
  // Defensive :root tokens first: layout {% style %} blocks often declare
  // --color-* outside any rule (invalid CSS, dropped by browsers), which would
  // leave theme var() references unresolved in previews. Real theme values
  // emitted below always win the cascade.
  const fallback = await layoutTokensFallback(store);
  if (fallback.trim()) extra += `<style>${fallback}</style>`;
  for (const name of ['css-variables', 'css-vars', 'design-tokens', 'theme-styles-variables']) {
    const out = await renderSnippet(store, name);
    if (out.trim()) { extra += out; break; }
  }
  // themes that define tokens inline in the layout itself — the extracted
  // blocks are bare CSS, so they need a <style> wrapper
  const layoutTokens = await renderLayoutTokens(store);
  if (layoutTokens.trim()) extra += `<style>${layoutTokens}</style>`;
  // Global module setup: Horizon-style themes register their ESM import map
  // plus shared globals (Theme.translations/routes) via a `scripts` snippet
  // that asset-URL scanning cannot see. Only the importmap and inline setup
  // scripts are taken — external <script src> tags are already covered by
  // externalScripts below, and re-emitting them would double-execute.
  try {
    const scriptsSnippet = await renderSnippet(store, 'scripts');
    if (scriptsSnippet) {
      for (const m of scriptsSnippet.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script\s*>/gi)) {
        const attrs = (m[1] || '').toLowerCase();
        if (/src\s*=/.test(attrs)) continue;
        if (/type\s*=\s*["']module["']/.test(attrs) && !/type\s*=\s*["']importmap["']/.test(attrs)) continue;
        extra += m[0];
      }
    }
  } catch { /* no scripts snippet — nothing to add */ }
  headSnippetCache.set(store, extra);
  return extra;
}

app.get('/preview/:store/:file', async (req, res) => {
  const { store, file } = req.params;
  res.set('Cache-Control', 'private, max-age=60, stale-while-revalidate=300');
  const previewSecure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.set('Set-Cookie', `sl_preview=${createPreviewToken()}; Path=/; HttpOnly; Max-Age=3600; SameSite=Lax${previewSecure}`);
  res.set('Content-Security-Policy', "default-src * data: blob:; script-src * 'unsafe-inline'; style-src * 'unsafe-inline'; connect-src 'none'; frame-ancestors 'self'; form-action 'none'; base-uri 'none'");

  // When a gallery store is configured, previews render on real Shopify,
  // proxied through this server (authenticates with the storefront password).
  // Custom sections aren't in the manifest and keep the local mock renderer.
  const cfg = storeConfig();
  const liveRequested = process.env.LIVE_PREVIEWS === '1' || req.query.live === '1';
  if (liveRequested && cfg.storeUrl && (cfg.previewThemeId || cfg.storefrontPassword)) {
    const entry = galleryManifest()[`${store}/${file}`];
    if (entry) {
      const params = new URLSearchParams({ view: entry.template });
      if (cfg.previewThemeId) params.set('preview_theme_id', cfg.previewThemeId);
      const target = `${cfg.storeUrl}/pages/${cfg.pageHandle}?${params}`;
      const key = crypto.createHash('md5').update(`${process.env.VERCEL_GIT_COMMIT_SHA || loadIndex().version || 'local'}:${target}`).digest('hex');
      let cached = previewCacheGet(key);
      if (cached && /Liquid error/i.test(cached)) { previewCacheDelete(key); cached = null; }
      // a missing lib-* template makes Shopify render the default page instead —
      // our preview templates always emit a "__library" section id
      if (cached && (!cached.includes('__library') || !hasVisiblePreview(cached))) { previewCacheDelete(key); cached = null; }
      if (cached) { res.set('X-Preview-Path', 'live-cached'); return res.type('html').send(cached); }
      const r = await shopifyGet(target);
      let html = await r.text();
      // sections that error live (missing product/blog refs etc.) render better
      // through the local mock — fall back instead of showing Shopify's error
      if (r.status === 200 && (/Liquid error/i.test(html) || !html.includes('__library') || !hasVisiblePreview(html))) {
        const mock = await localPreview(req, res);
        return mock;
      }
      if (r.status === 200) {
        // Same CJS-shim rationale as local previews: the live theme's own
        // bundles (and their pinned third-party CDN imports) must not throw
        // ReferenceErrors inside the sandboxed preview iframe.
        if (html.includes('</head>')) html = html.replace('</head>', `${CJS_SHIM}</head>`);
        previewCacheSet(key, html);
      }
      else return localPreview(req, res); // not in the published theme yet — mock render
      res.set('X-Preview-Path', 'live');
      return res.status(r.status).type('html').send(html);
    }
  }
  return localPreview(req, res);
});

function assetUrlForStore(store, asset) {
  const normalized = normalizeAssetName(asset);
  return `/assets/${encodeURIComponent(store)}/${normalized.split('/').map((part) => encodeURIComponent(part)).join('/')}`;
}

function assetFileFromUrl(url, expectedStore) {
  const match = String(url || '').match(/^\/assets\/([^/]+)\/(.+)$/i);
  if (!match) return null;
  try {
    if (decodeURIComponent(match[1]) !== expectedStore) return null;
    return normalizeAssetName(decodeURIComponent(match[2]));
  } catch { return null; }
}

function assetExists(storePath, asset) {
  if (!storePath || String(asset).split(/[\\/]/).includes('..')) return false;
  const assetsRoot = path.join(storePath, 'assets');
  const full = path.resolve(assetsRoot, normalizeAssetName(asset));
  const relative = path.relative(assetsRoot, full);
  return !relative.startsWith('..') && !path.isAbsolute(relative) && fs.existsSync(full);
}

const DEMO_IMAGE = '/assets/demo-image.jpg';
const DEMO_ICON = '/assets/star.svg';
const MEDIA_EXT_RE = /\.(?:avif|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/i;
const ICON_CONTEXT_RE = /(?:icon|pictogram|logo|favicon|symbol|badge|arrow|chevron|caret|cart|search|account|user|menu|close|check|plus|minus|social|payment|star|heart|filter|share|flag)/i;

function isIconContext(value) {
  return ICON_CONTEXT_RE.test(String(value || '').replace(/[-_]/g, ' '));
}

function mediaPlaceholder(value, context = '') {
  const url = String(value || '').trim();
  if (/(?:^|\/)assets\/star\.svg(?:[?#]|$)/i.test(url)) return DEMO_ICON;
  if (/(?:^|\/)assets\/demo-image\.jpg(?:[?#]|$)/i.test(url)) return DEMO_IMAGE;
  if (isIconContext(`${url} ${context}`)) return DEMO_ICON;
  return DEMO_IMAGE;
}

function replaceAttribute(attrs, name, replacer) {
  return attrs.replace(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'gi'), (_, quote, value) => `${name}=${quote}${replacer(value, name)}${quote}`);
}

function normalizeSrcset(value, context = '') {
  return String(value || '').split(',').map((candidate) => {
    const trimmed = candidate.trim();
    const match = trimmed.match(/^(\S+)(\s+[\s\S]*)?$/);
    return match ? `${mediaPlaceholder(match[1], context)}${match[2] || ''}` : mediaPlaceholder(trimmed, context);
  }).join(', ');
}

function normalizeCssUrls(value, context = '', token = '') {
  return String(value || '').replace(/url\(\s*(["'])([\s\S]*?)\1\s*\)|url\(\s*([^)'"\s][^)]*?)\s*\)/gi, (full, quote, quotedUrl, bareUrl) => {
    const trimmed = String(quotedUrl ?? bareUrl ?? '').trim();
    const actualQuote = quote || '';
    if (/^(?:blob:|#)/i.test(trimmed)) return full;
    if (/^data:image\//i.test(trimmed)) {
      const placeholder = /^data:image\/svg\+xml/i.test(trimmed) ? DEMO_ICON : DEMO_IMAGE;
      return `url(${actualQuote}${token ? previewAssetToken(placeholder, token) : placeholder}${actualQuote})`;
    }
    if (/^data:/i.test(trimmed)) return full;
    if (!trimmed || trimmed === '[object Object]' || MEDIA_EXT_RE.test(trimmed)) {
      const placeholder = mediaPlaceholder(trimmed, context);
      return `url(${actualQuote}${token ? previewAssetToken(placeholder, token) : placeholder}${actualQuote})`;
    }
    return full;
  });
}

function normalizeTextSymbols(html) {
  const star = `<img src="${DEMO_ICON}" alt="" aria-hidden="true" class="preview-symbol">`;
  return String(html || '')
    .replace(/[★☆✦]{2,}/g, (run) => run.split('').map(() => star).join(''))
    .replace(/>(\s*)([✦✕✖→←↑↓])(?:\s*)</g, (_, space) => `${space}${star}`);
}

function normalizeInlineSvg(html) {
  return String(html || '').replace(/<svg\b([^>]*)>[\s\S]*?<\/svg>/gi, (full, attrs) => {
    const width = Number((attrs.match(/\bwidth=["']?(\d+)/i) || [])[1] || 0);
    const viewBox = (attrs.match(/\bviewBox=["']\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)/i) || []);
    const viewWidth = Number(viewBox[1] || 0), viewHeight = Number(viewBox[2] || 0);
    const smallGraphic = (width > 0 && width <= 32) || (viewWidth > 0 && viewWidth <= 32 && viewHeight > 0 && viewHeight <= 32);
    const iconContext = /\b(?:class|id|aria-label|data-icon)=["'][^"']*\b(?:icon|pictogram|logo|symbol|mute|unmute|play|pause|arrow|chevron|caret|check|close|plus|minus|star|heart)\b/i.test(attrs)
      || smallGraphic;
    if (!iconContext) return full;
    const cls = (attrs.match(/\bclass=["']([^"']*)["']/i) || [])[1];
    return `<img src="${DEMO_ICON}" alt="" aria-hidden="true"${cls ? ` class="${cls}"` : ''}>`;
  });
}

function normalizePreviewMedia(html) {
  let out = String(html || '').replace(/<([a-z][\w:-]*)\b([^>]*)>/gi, (full, tag, attrs) => {
    let next = attrs;
    const context = `${tag} ${attrs}`;
    if (tag.toLowerCase() === 'img') {
      next = replaceAttribute(next, 'src', (value) => mediaPlaceholder(value, context));
      next = replaceAttribute(next, 'data-src', (value) => mediaPlaceholder(value, context));
      next = replaceAttribute(next, 'srcset', (value) => normalizeSrcset(value, context));
      next = replaceAttribute(next, 'data-srcset', (value) => normalizeSrcset(value, context));
      if (!/\bsrc\s*=/i.test(next) && /\b(?:srcset|data-srcset)\s*=/i.test(next)) next += ` src="${mediaPlaceholder('', context)}"`;
    } else if (tag.toLowerCase() === 'video') {
      next = replaceAttribute(next, 'poster', (value) => mediaPlaceholder(value, context));
      next = replaceAttribute(next, 'data-poster', (value) => mediaPlaceholder(value, context));
      next = next.replace(/\s(?:data-)?src\s*=\s*(["'])\s*\1/gi, '');
      if (!/\bposter\s*=/i.test(next)) next += ` poster="${mediaPlaceholder('', context)}"`;
    } else if (tag.toLowerCase() === 'source') {
      if (/\btype=["']image\//i.test(attrs) || /\bsrcset\s*=/i.test(attrs)) {
        next = replaceAttribute(next, 'src', (value) => mediaPlaceholder(value, context));
        next = replaceAttribute(next, 'srcset', (value) => normalizeSrcset(value, context));
        next = replaceAttribute(next, 'data-srcset', (value) => normalizeSrcset(value, context));
      }
      next = next.replace(/\s(?:data-)?src\s*=\s*(["'])\s*\1/gi, '');
    } else if (tag.toLowerCase() === 'link' && /\brel=["'][^"']*preload[^"']*["']/i.test(attrs) && /\bas=["']image["']/i.test(attrs)) {
      next = replaceAttribute(next, 'href', (value) => mediaPlaceholder(value, context));
    }
    next = next.replace(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/gi, (match, quote, style) => `style=${quote}${normalizeCssUrls(style, context)}${quote}`);
    return `<${tag}${next}>`;
  });
  out = out.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (full, attrs, css) => `<style${attrs}>${normalizeCssUrls(css, 'style')}</style>`);
  return normalizeTextSymbols(normalizeInlineSvg(out));
}

function sanitizePreviewHtml(html, store, storePath) {
  const canonical = String(html || '').replace(/\b(src|href)=(["'])([^"']+)\2/gi, (full, attribute, quote, url) => {
    if (!/^\/assets\//i.test(url)) return full;
    const file = assetFileFromUrl(url, store);
    if (!file) return full;
    if (assetExists(storePath, file)) {
      const canonicalUrl = assetUrlForStore(store, file);
      return url === canonicalUrl ? full : `${attribute}=${quote}${canonicalUrl}${quote}`;
    }
    const extension = path.extname(file).toLowerCase();
    if (['.js', '.mjs', '.css'].includes(extension)) return '';
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.svg'].includes(extension)) return `${attribute}=${quote}${mediaPlaceholder(file, attribute)}${quote}`;
    return full;
  });
  return normalizePreviewMedia(canonical);
}

function readAssetText(storePath, asset) {
  if (!storePath || String(asset).split(/[\\/]/).includes('..')) return '';
  const assetsRoot = path.join(storePath, 'assets');
  const full = path.resolve(assetsRoot, normalizeAssetName(asset));
  const relative = path.relative(assetsRoot, full);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return '';
  try { return fs.readFileSync(full, 'utf8'); } catch { return ''; }
}

async function localPreview(req, res) {
  const { store, file } = req.params;
  res.set('X-Preview-Path', 'local');
  const storePath = findStore(store);
  if (store !== 'custom' && !storePath) return res.status(404).send('unknown store');
  try {
    if (store === 'custom') {
      if (!/^[\w.-]+(\.liquid)?$/.test(file)) return res.status(400).send('bad file');
      const slug = file.replace(/\.liquid$/, '');
      assertCustomSlug(slug);
      await ensureCustomSectionRemote(slug);
      const meta = customSectionMeta(slug);
      const { liquid, css, js } = customSectionSources(slug);
      if (!meta || !liquid.trim()) {
        if (customSectionsRestoreError) return res.status(503).send(`Custom sections unavailable: ${customSectionsRestoreError.message}`);
        return res.status(404).send('not found');
      }
      if (/{%-?\s*content_for\b/i.test(liquid)) res.set('X-Preview-Path', 'local-context');
      const contextStore = meta.contextStore === 'custom' ? 'custom' : meta.contextStore;
      const contextPath = contextStore === 'custom' ? null : findStore(contextStore);
      const deps = contextPath ? getLayoutDeps(contextStore) : { css: [], js: [] };
      const exists = (asset) => assetExists(contextPath, asset);
      const cssLinks = [...new Set([...deps.css, ...extractAssetRefs(liquid).filter((asset) => asset.endsWith('.css'))].filter(exists))]
        .map((asset) => assetUrlForStore(contextStore, asset));
      const externalScripts = deps.js.filter(exists).map((asset) => ({ src: assetUrlForStore(contextStore, asset), esm: isEsmJs(readAssetText(contextPath, asset)) }));
      const headExtra = contextPath ? await getLayoutHeadExtra(contextStore) : '';
      const fontsLink = contextPath ? (() => { try { return googleFontsLink(getEngine(contextStore, contextPath)); } catch { return ''; } })() : '';
      const rendered = await renderSectionSource(contextStore, liquid, { sectionId: slug });
      const renderedHtml = contextPath ? sanitizePreviewHtml(rendered.html, contextStore, contextPath) : normalizePreviewMedia(rendered.html);
      return res.type('html').send(previewPage({
        title: meta.name, html: renderedHtml, inlineCss: css, scripts: js ? [js] : [],
        error: rendered.error, cssLinks, externalScripts, headExtra: headExtra + fontsLink,
      }));
    }
    if (!/^[\w.-]+\.liquid$/.test(file)) return res.status(400).send('bad file');
    const idx = loadIndex();
    const meta = idx.sections.find((s) => s.store === store && s.file === file);
    if (meta?.usesContentFor) res.set('X-Preview-Path', 'local-context');
    const r = await renderStoreSection(store, file);
    const deps = getLayoutDeps(store);
    const exists = (asset) => assetExists(storePath, asset);
    const cssLinks = [...new Set([...deps.css, ...(meta?.assets || []).filter((asset) => asset.endsWith('.css'))].filter(exists))]
      .map((asset) => assetUrlForStore(store, asset));
    const isModuleAsset = (asset) => isEsmJs(readAssetText(storePath, asset));
    const sectionAssetJs = (meta?.assets || []).filter((a) => /\.m?js$/.test(a) && exists(a) && !deps.js.includes(a));
    const scripts = [...r.js ? [r.js] : []];
    const externalScripts = deps.js.filter(exists).map((asset) => ({ src: assetUrlForStore(store, asset), esm: isModuleAsset(asset) }));
    for (const a of sectionAssetJs) {
      // The section already loads it with its own <script src> (module or
      // classic, including document.write loaders) — shipping a second copy
      // would double-execute behaviours, and a classic inline of an ESM
      // bundle throws outright.
      const fileRe = escapeRegExp(a);
      if (new RegExp(`<script[^>]*src=[^>]*${fileRe}|document\\.write\\([^)]*${fileRe}`, 'i').test(r.html)) continue;
      if (isModuleAsset(a)) externalScripts.push({ src: `/assets/${store}/${a}`, esm: true });
      // Escape script-close tags so inlined code cannot break out of its element.
      else scripts.push(readAssetText(storePath, a).replace(/<\/script/gi, '<\\/script'));
    }
    const headExtra = await getLayoutHeadExtra(store);
    const fontsLink = (() => { try { return googleFontsLink(getEngine(store, storePath)); } catch { return ''; } })();
    const renderedHtml = sanitizePreviewHtml(r.html + (r.legacyCss ? `<style>${r.legacyCss}</style>` : ''), store, storePath);
    res.type('html').send(previewPage({ title: `${meta?.name || file} — ${store}`, html: renderedHtml, cssLinks, scripts, error: r.error, externalScripts, headExtra: headExtra + fontsLink }));
  } catch (e) {
    res.status(500).type('html').send(previewPage({ title: 'error', html: '', error: e.message }));
  }
}

app.get('/reset.css', (req, res) => { res.type('css').send(RESET_CSS); });

/* ------------------------------ static assets/ph ------------------------------ */

app.use('/assets', (req, res, next) => {
  const rootAsset = req.path.replace(/^\//, '');
  if (rootAsset === 'demo-image.jpg' || rootAsset === 'star.svg') {
    res.set('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    return res.sendFile(path.join(ROOT, 'assets', rootAsset), (error) => { if (error) res.status(404).end(); });
  }
  const parts = req.path.replace(/^\//, '').split('/');
  const store = decodeURIComponent(parts.shift() || '');
  const rel = parts.join('/');
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const storeRoot = findStore(store);
  if (!storeRoot) return res.status(404).end();
  const assetsRoot = path.join(storeRoot, 'assets');
  const full = path.resolve(assetsRoot, safe);
  if (path.relative(assetsRoot, full).startsWith('..') || path.isAbsolute(path.relative(assetsRoot, full))) return res.status(403).end();
  res.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
  if (path.extname(safe).toLowerCase() === '.css') {
    try {
      const token = typeof req.query.sl_preview === 'string' && verifyPreviewToken(req.query.sl_preview) ? req.query.sl_preview : '';
      return res.type('css').send(normalizeCssUrls(fs.readFileSync(full, 'utf8'), safe, token));
    } catch { return res.status(404).end(); }
  }
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

if (IS_SERVERLESS) {
  // Vercel: bootReady handles data restore; no listen call (serverless).
} else if (require.main === module) {
  gitInit();
  initDataRepo();
  app.listen(PORT, () => console.log(`Section Library → http://localhost:${PORT}`));
}

module.exports = app;
module.exports.normalizePreviewMedia = normalizePreviewMedia;
module.exports.verifyPreviewToken = verifyPreviewToken;
