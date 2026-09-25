const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { zipSync } = require('fflate');
const { findStore } = require('./roots');
const { extractSchema, extractAssetRefs, extractSnippetRefs, normalizeAssetName, scanRenderEdits } = require('./section-meta');
const { templateSectionBody } = require('./merge');

const SAFE_SECTION = /^[\w.-]+\.liquid$/;
const MAX_ITEMS = 500;
const BASE_STORE = 'base';
// Shopify platform limits, per the theme architecture docs.
const MAX_SECTIONS_PER_TEMPLATE = 25;
const MAX_BLOCKS_PER_SECTION = 50;
// Page types a store needs to actually render. Shopify requires none of these to
// upload, but a page type without a template cannot be rendered.
const CORE_TEMPLATES = ['index', 'product', 'collection', 'cart', 'page', 'blog', 'article', 'search', '404', 'password', 'list-collections', 'gift_card'];
// Deprecated legacy customer templates. Publishing without them upgrades the
// merchant to new customer accounts, which no longer render from the theme.
const LEGACY_CUSTOMER_TEMPLATES = ['customers/account', 'customers/activate_account', 'customers/login', 'customers/order', 'customers/register', 'customers/reset_password', 'customers/addresses'];
// These template types must be Liquid, never JSON.
const LIQUID_ONLY_TEMPLATES = ['gift_card', 'robots.txt', 'agents.md', 'llms.txt', 'llms-full.txt'];

function liquidTagArgs(source, tag) {
  const out = [];
  const pattern = new RegExp(`\\{%-?\\s*${tag}\\s+(['"])([^'"]+)\\1`, 'g');
  let match;
  while ((match = pattern.exec(source))) out.push(match[2]);
  return out;
}

// The sections a base theme cannot function without: everything its layout, its
// section groups, or its templates reference. Derived from the base store rather
// than hardcoded, so adding a template later cannot silently orphan a section.
function coreSectionTypes(basePath) {
  const core = new Set();
  const sectionsDir = path.join(basePath, 'sections');
  const addGroup = (name) => {
    const file = path.join(sectionsDir, `${name}.json`);
    if (!fs.existsSync(file)) return;
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
    for (const section of Object.values(data.sections || {})) if (section && section.type) core.add(section.type);
  };
  const scanLiquid = (text) => {
    for (const name of liquidTagArgs(text, 'section')) core.add(name);
    for (const name of liquidTagArgs(text, 'sections')) addGroup(name);
  };
  // Every section group counts, not just the ones a layout renders, so a group can
  // never end up referencing a section this pass removed.
  for (const file of listFiles(sectionsDir)) if (file.rel.endsWith('.json')) addGroup(path.basename(file.rel, '.json'));
  for (const file of listFiles(path.join(basePath, 'layout'))) {
    if (file.rel.endsWith('.liquid')) scanLiquid(fs.readFileSync(file.full, 'utf8'));
  }
  for (const file of listFiles(path.join(basePath, 'templates'))) {
    if (file.rel === 'index.json') continue; // regenerated from the pack
    if (file.rel.endsWith('.json')) {
      let data;
      try { data = JSON.parse(fs.readFileSync(file.full, 'utf8')); } catch { continue; }
      for (const section of Object.values(data.sections || {})) if (section && section.type) core.add(section.type);
    } else if (file.rel.endsWith('.liquid')) {
      scanLiquid(fs.readFileSync(file.full, 'utf8'));
    }
  }
  return core;
}

// Keeps only the core section files. Section group JSON files are always kept.
function pruneSections(outDir, core) {
  const sectionsDir = path.join(outDir, 'sections');
  if (!fs.existsSync(sectionsDir)) return [];
  const removed = [];
  for (const file of listFiles(sectionsDir)) {
    if (!file.rel.endsWith('.liquid')) continue;
    const type = path.basename(file.rel, '.liquid');
    if (core.has(type)) continue;
    fs.rmSync(file.full, { force: true });
    removed.push(type);
  }
  return removed;
}

// Every snippet, block, and asset reachable from the files a theme actually
// renders. Anything else is dead weight in the upload.
function pruneOrphans(outDir, protectedFiles = new Set()) {
  const roots = ['layout', 'templates', 'sections', 'config'];
  const seeds = [];
  for (const dir of roots) {
    for (const file of listFiles(path.join(outDir, dir))) {
      if (/\.(liquid|json|css|m?js)$/.test(file.rel)) seeds.push(file);
    }
  }
  const keep = { snippets: new Set(), assets: new Set(), blocks: new Set() };
  const seen = new Set();
  const sectionSchemas = new Map();
  const instantiated = new Set();
  const queue = [];

  const scan = (text) => {
    for (const name of extractSnippetRefs(text)) keep.snippets.add(name);
    for (const name of extractAssetRefs(text)) keep.assets.add(name);
    for (const name of textAssetRefs(text, '')) keep.assets.add(name);
    for (const match of text.matchAll(/\bcontent_for\s+(['"])block\1[\s\S]{0,500}?\btype\s*:\s*(['"])([\w-]+)\2/gi)) keep.blocks.add(match[3]);
  };

  // JSON templates and section groups tell us which sections are live, and which
  // block instances must therefore resolve.
  for (const file of seeds.filter((f) => f.rel.endsWith('.json') && f.rel.startsWith('templates'))) {
    let data;
    try { data = JSON.parse(fs.readFileSync(file.full, 'utf8')); } catch { continue; }
    for (const section of Object.values(data.sections || {})) {
      if (!section || !section.type) continue;
      instantiated.add(section.type);
      for (const block of Object.values(section.blocks || {})) if (block && block.type) keep.blocks.add(block.type);
    }
  }
  for (const file of seeds.filter((f) => f.rel.startsWith('sections/') && f.rel.endsWith('.json'))) {
    let data;
    try { data = JSON.parse(fs.readFileSync(file.full, 'utf8')); } catch { continue; }
    for (const section of Object.values(data.sections || {})) {
      if (!section || !section.type) continue;
      instantiated.add(section.type);
      for (const block of Object.values(section.blocks || {})) if (block && block.type) keep.blocks.add(block.type);
    }
  }

  for (const file of seeds) {
    seen.add(file.full);
    queue.push(file.full);
    if (file.rel.startsWith('sections/') && file.rel.endsWith('.liquid')) {
      let schema = null;
      try { schema = extractSchema(fs.readFileSync(file.full, 'utf8')); } catch {}
      if (schema) sectionSchemas.set(file.full, schema);
    }
  }

  // A section that a live template instantiates keeps the blocks its schema declares.
  for (const [full, schema] of sectionSchemas) {
    if (!instantiated.has(path.basename(full, '.liquid'))) continue;
    for (const block of schema.blocks || []) if (block && block.type && !block.type.startsWith('@')) keep.blocks.add(block.type);
  }

  const enqueue = (kind, name) => {
    const rel = kind === 'snippet' ? `snippets/${name}.liquid` : kind === 'block' ? `blocks/${name}.liquid` : `assets/${name}`;
    const full = path.join(outDir, rel);
    if (fs.existsSync(full) && !seen.has(full)) { seen.add(full); queue.push(full); }
  };

  while (queue.length) {
    const full = queue.shift();
    if (!/\.(liquid|json|css|m?js)$/.test(full)) continue;
    let text = '';
    try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
    const before = { s: keep.snippets.size, a: keep.assets.size, b: keep.blocks.size };
    scan(text);
    for (const name of keep.snippets) enqueue('snippet', name);
    for (const name of keep.assets) enqueue('asset', name);
    for (const name of keep.blocks) enqueue('block', name);
    if (keep.snippets.size !== before.s || keep.assets.size !== before.a || keep.blocks.size !== before.b) {
      for (const name of keep.snippets) enqueue('snippet', name);
      for (const name of keep.assets) enqueue('asset', name);
      for (const name of keep.blocks) enqueue('block', name);
    }
  }

  const removed = [];
  for (const [kind, names] of [['snippet', keep.snippets], ['block', keep.blocks], ['asset', keep.assets]]) {
    const dir = path.join(outDir, kind === 'asset' ? 'assets' : `${kind}s`);
    if (!fs.existsSync(dir)) continue;
    for (const file of listFiles(dir)) {
      const rel = file.rel;
      const name = kind === 'asset' ? rel : path.basename(rel, '.liquid');
      if (names.has(name) || protectedFiles.has(path.posix.join(kind === 'asset' ? 'assets' : `${kind}s`, rel))) continue;
      fs.rmSync(file.full, { force: true });
      removed.push(rel);
    }
  }
  return removed;
}

// Validates a ready-to-upload theme against Shopify's documented requirements so
// an export is a working store, not just a folder of section files.
function validateThemeStore(outDir) {
  const errors = [];
  const warnings = [];
  const has = (rel) => fs.existsSync(path.join(outDir, rel));
  const read = (rel) => {
    try { return fs.readFileSync(path.join(outDir, rel), 'utf8'); } catch { return ''; }
  };

  if (!has('layout/theme.liquid')) {
    errors.push('Missing required layout/theme.liquid (the only file required to upload a theme)');
  } else {
    const layout = read('layout/theme.liquid');
    if (!/content_for_header/.test(layout)) errors.push('layout/theme.liquid is missing the required content_for_header');
    if (!/content_for_layout/.test(layout)) errors.push('layout/theme.liquid is missing the required content_for_layout');
    for (const group of liquidTagArgs(layout, 'sections')) {
      const rel = `sections/${group}.json`;
      if (!has(rel)) { errors.push(`layout/theme.liquid renders section group ${group} but ${rel} is missing`); continue; }
      let data;
      try { data = JSON.parse(read(rel)); } catch { errors.push(`Section group ${rel} is not valid JSON`); continue; }
      for (const [id, section] of Object.entries(data.sections || {})) {
        if (section && !has(`sections/${section.type}.liquid`)) errors.push(`Section group ${rel} references missing section: ${section.type} (id ${id})`);
      }
      const count = Array.isArray(data.order) ? data.order.length : Object.keys(data.sections || {}).length;
      if (count > MAX_SECTIONS_PER_TEMPLATE) errors.push(`Section group ${rel} has ${count} sections, over the Shopify limit of ${MAX_SECTIONS_PER_TEMPLATE}`);
    }
    for (const name of liquidTagArgs(layout, 'section')) {
      if (!has(`sections/${name}.liquid`)) errors.push(`layout/theme.liquid renders missing static section: ${name}`);
    }
  }

  for (const required of ['config/settings_schema.json', 'config/settings_data.json']) {
    if (!has(required)) errors.push(`Missing required config/${path.basename(required)}`);
  }

  for (const name of LIQUID_ONLY_TEMPLATES) {
    if (has(`templates/${name}.json`)) errors.push(`templates/${name}.json must be a Liquid template, not JSON`);
  }

  const sectionTypes = new Set(listFiles(path.join(outDir, 'sections')).filter((f) => f.rel.endsWith('.liquid')).map((f) => path.basename(f.rel, '.liquid')));
  for (const rel of ['templates', 'sections']) {
    for (const file of listFiles(path.join(outDir, rel))) {
      if (!file.rel.endsWith('.json')) continue;
      let data;
      try { data = JSON.parse(fs.readFileSync(file.full, 'utf8')); } catch { errors.push(`Invalid template JSON: ${file.rel}`); continue; }
      const sections = data.sections || {};
      const ids = Object.keys(sections);
      for (const id of ids) {
        const section = sections[id];
        if (section && section.type && !sectionTypes.has(section.type)) errors.push(`${file.rel} references missing section: ${section.type}`);
        const blockCount = section && section.blocks ? Object.keys(section.blocks).length : 0;
        if (blockCount > MAX_BLOCKS_PER_SECTION) errors.push(`${file.rel} section ${id} has ${blockCount} blocks, over the Shopify limit of ${MAX_BLOCKS_PER_SECTION}`);
      }
      if (rel === 'templates' && ids.length > MAX_SECTIONS_PER_TEMPLATE) {
        errors.push(`${file.rel} renders ${ids.length} sections, over the Shopify limit of ${MAX_SECTIONS_PER_TEMPLATE}`);
      }
      for (const id of data.order || []) {
        if (!sections[id]) errors.push(`${file.rel} order lists ${id} which is not in sections`);
      }
    }
  }

  const templateFiles = listFiles(path.join(outDir, 'templates')).map((f) => f.rel.replace(/^templates\//, '').replace(/\.(json|liquid)$/, ''));
  for (const name of CORE_TEMPLATES) {
    if (!templateFiles.includes(name)) warnings.push(`No ${name} template: that page type cannot render`);
  }
  for (const name of LEGACY_CUSTOMER_TEMPLATES) {
    if (templateFiles.includes(name)) warnings.push(`${name}.json is a deprecated legacy customer template; new customer accounts render independently of the theme`);
  }
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

function slugify(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'section';
}

function storePrefixes(stores, baseStore) {
  const used = new Set();
  const out = {};
  for (const store of [...new Set(stores)]) {
    if (store === baseStore) { out[store] = ''; continue; }
    const base = slugify(store);
    let prefix = `${base}--`;
    if (used.has(prefix)) prefix = `${base}-${crypto.createHash('sha1').update(store).digest('hex').slice(0, 6)}--`;
    while (used.has(prefix)) prefix = `${base}-${crypto.randomBytes(3).toString('hex')}--`;
    used.add(prefix);
    out[store] = prefix;
  }
  return out;
}

function clearDirectory(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function copyTheme(source, destination) {
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(source, src).replace(/\\/g, '/');
      return !rel.split('/').some((part) => part === '.git' || part === 'node_modules') && !rel.endsWith('.DS_Store');
    },
  });
}

function listFiles(dir, prefix = '') {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, rel));
    else out.push({ full, rel });
  }
  return out;
}

function zipDirectory(dir) {
  const entries = {};
  for (const file of listFiles(dir)) entries[file.rel] = new Uint8Array(fs.readFileSync(file.full));
  return Buffer.from(zipSync(entries, { level: 9 }));
}

function layoutAssets(storePath) {
  const assets = new Set();
  const snippets = new Set();
  const scan = (text) => {
    for (const asset of extractAssetRefs(text)) if (/\.m?js$|\.css$/i.test(asset)) assets.add(asset);
    for (const name of extractSnippetRefs(text)) snippets.add(name);
  };
  let layout = '';
  try { layout = fs.readFileSync(path.join(storePath, 'layout/theme.liquid'), 'utf8'); } catch { return { assets: [], snippets: [] }; }
  scan(layout);
  const queue = [...snippets];
  const seen = new Set();
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    try {
      const text = fs.readFileSync(path.join(storePath, 'snippets', `${name}.liquid`), 'utf8');
      scan(text);
      for (const next of extractSnippetRefs(text)) if (!seen.has(next)) queue.push(next);
    } catch {}
  }
  return { assets: [...assets], snippets: [...snippets] };
}

function textAssetRefs(text, from) {
  const refs = new Set();
  const add = (value) => {
    const ref = String(value || '').trim();
    if (!ref || /^(?:data:|blob:|https?:|\/\/|#)/i.test(ref)) return;
    if (!ref.startsWith('.') && !/\.(?:css|m?js|woff2?|png|jpe?g|svg|gif|webp|avif|eot|ttf|otf)(?:[?#]|$)/i.test(ref)) return;
    const resolved = ref.startsWith('/') ? ref.replace(/^\/+/, '') : path.posix.normalize(path.posix.join(path.posix.dirname(from), ref));
    if (resolved && !resolved.split('/').includes('..')) refs.add(normalizeAssetName(resolved));
  };
  for (const match of String(text).matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) add(match[1]);
  for (const match of String(text).matchAll(/(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/gi)) add(match[1]);
  return [...refs];
}

function dependencyPath(storePath, kind, name) {
  if (!storePath) return null;
  if (kind === 'snippet') return path.join(storePath, 'snippets', `${name}.liquid`);
  if (kind === 'block') return path.join(storePath, 'blocks', `${name}.liquid`);
  return path.join(storePath, 'assets', name);
}

function hasDependency(storePath, kind, name) {
  const full = dependencyPath(storePath, kind, name);
  return !!full && fs.existsSync(full);
}

class ExportBuilder {
  constructor({ outDir, baseStore, items, prefixes, mode }) {
    this.outDir = outDir;
    this.baseStore = baseStore;
    this.items = items;
    this.prefixes = prefixes;
    this.mode = mode;
    this.queue = [];
    this.copied = new Set();
    this.assetExports = new Map();
    this.assetFiles = [];
    this.missing = [];
    this.warnings = [];
    this.packFiles = new Set();
    this.authoredFiles = new Set();
    this.globalRenders = new Map();
  }

  storePath(store) {
    return store === 'custom' ? null : findStore(store);
  }

  resolveDependency(sourceStore, kind, name) {
    const sourcePath = this.storePath(sourceStore);
    if (hasDependency(sourcePath, kind, name)) return sourceStore;
    if (sourceStore !== this.baseStore && hasDependency(this.storePath(this.baseStore), kind, name)) return this.baseStore;
    return null;
  }

  exportedName(kind, store, name) {
    const prefix = this.prefixes[store] || '';
    return `${prefix}${kind === 'asset' ? normalizeAssetName(name) : name}`;
  }

  enqueue(sourceStore, kind, name) {
    const normalized = kind === 'asset' ? normalizeAssetName(name) : name;
    if (kind === 'asset' && (!normalized || normalized.split(/[\\/]/).includes('..'))) {
      this.missing.push({ store: sourceStore, kind, name: normalized });
      return null;
    }
    const actualStore = this.resolveDependency(sourceStore, kind, normalized);
    if (!actualStore) {
      this.missing.push({ store: sourceStore, kind, name: normalized });
      return null;
    }
    const exported = this.exportedName(kind, actualStore, normalized);
    const key = `${kind}:${actualStore}:${normalized}`;
    if (kind === 'asset') this.assetExports.set(`${actualStore}:${normalized}`, exported);
    if (this.mode === 'theme' && actualStore === this.baseStore) return exported;
    if (this.copied.has(key)) return exported;
    this.copied.add(key);
    this.queue.push({ kind, name: normalized, store: actualStore, exported });
    return exported;
  }

  blockExportName(sourceStore, name) {
    const actualStore = this.resolveDependency(sourceStore, 'block', name);
    return actualStore ? this.exportedName('block', actualStore, name) : name;
  }

  rewriteLiquid(source, sourceStore) {
    let out = source;
    const edits = scanRenderEdits(out);
    if (edits) {
      const resolved = [];
      for (const edit of edits) {
        const exported = this.enqueue(sourceStore, 'snippet', edit.name);
        if (exported) resolved.push({ ...edit, replacement: exported });
      }
      resolved.sort((a, b) => b.start - a.start);
      for (const edit of resolved) out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
    } else {
      out = out.replace(/({%-?\s*(?:render|include)\s+)(['"])([\w-]+)(\2)/g, (full, lead, quote, name, closing) => {
        const exported = this.enqueue(sourceStore, 'snippet', name);
        return exported ? `${lead}${quote}${exported}${closing}` : full;
      });
    }
    out = out.replace(/(\bcontent_for\s+(['"])block\2[\s\S]{0,500}?\btype\s*:\s*(['"]))([\w-]+)(\3)/gi, (full, lead, blockQuote, typeQuote, name, closing) => {
      const exported = this.enqueue(sourceStore, 'block', name);
      return exported ? `${lead}${typeQuote}${exported}${closing}` : full;
    });
    out = out.replace(/(['"])([\w./-]+\.(?:css|mjs|js|woff2?|png|jpe?g|svg|gif|webp|avif|eot|ttf|otf))\1\s*\|\s*(asset_url|shopify_asset_url|inline_asset_content|stylesheet_tag|script_tag|preload_tag)/g, (full, quote, file, filter) => {
      const name = normalizeAssetName(file);
      const exported = this.enqueue(sourceStore, 'asset', name);
      return exported ? `${quote}${exported}${quote} | ${filter}` : full;
    });
    return out;
  }

  rewriteAssetText(text, store, name) {
    if (!/\.(css|m?js|liquid)$/i.test(name)) return text;
    let out = text;
    for (const [key, exported] of this.assetExports.entries()) {
      const [assetStore, original] = key.split(':');
      if (assetStore !== store || original === exported) continue;
      out = out.split(original).join(exported);
    }
    return out;
  }

  processQueue() {
    while (this.queue.length) {
      const item = this.queue.shift();
      const source = dependencyPath(this.storePath(item.store), item.kind, item.name);
      if (!source || !fs.existsSync(source)) {
        this.missing.push({ store: item.store, kind: item.kind, name: item.name });
        continue;
      }
      const exportedFile = item.kind === 'asset' ? item.exported : `${item.exported}.liquid`;
      const dir = item.kind === 'asset' ? 'assets' : item.kind === 'block' ? 'blocks' : 'snippets';
      const destination = path.join(this.outDir, dir, exportedFile);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      this.packFiles.add(path.posix.join(dir, exportedFile));
      if (item.store !== this.baseStore) this.authoredFiles.add(path.posix.join(dir, exportedFile));
      if (item.kind === 'asset') {
        fs.copyFileSync(source, destination);
        this.assetFiles.push({ destination, store: item.store, name: item.name });
        if (/\.(css|m?js|liquid)$/i.test(item.name)) {
          const text = fs.readFileSync(source, 'utf8');
          for (const ref of textAssetRefs(text, item.name)) this.enqueue(item.store, 'asset', ref);
        }
      } else {
        fs.writeFileSync(destination, this.rewriteLiquid(fs.readFileSync(source, 'utf8'), item.store));
      }
    }
  }

  finalizeAssets() {
    for (const file of this.assetFiles) {
      if (!/\.(css|m?js|liquid)$/i.test(file.name)) continue;
      const text = fs.readFileSync(file.destination, 'utf8');
      fs.writeFileSync(file.destination, this.rewriteAssetText(text, file.store, file.name));
    }
    this.assetFiles = [];
  }

  globalRender(store) {
    if (this.globalRenders.has(store)) return this.globalRenders.get(store);
    const storePath = this.storePath(store);
    if (!storePath) return '';
    const deps = layoutAssets(storePath);
    const assets = deps.assets.map((name) => this.enqueue(store, 'asset', name)).filter(Boolean);
    this.processQueue();
    if (!assets.length) return '';
    const name = `pack-assets--${slugify(store)}`;
    const tags = assets.map((asset) => /\.css$/i.test(asset)
      ? `{{ '${asset}' | asset_url | stylesheet_tag }}`
      : `{{ '${asset}' | asset_url | script_tag }}`).join('\n');
    fs.writeFileSync(path.join(this.outDir, 'snippets', `${name}.liquid`), tags);
    const render = `{% render '${name}' %}`;
    this.globalRenders.set(store, render);
    return render;
  }

  addSection(item) {
    const source = this.rewriteLiquid(item.sourceText, item.store);
    const needsGlobal = this.mode === 'pack' || item.store !== this.baseStore;
    const injection = needsGlobal ? `${this.globalRender(item.store)}\n` : '';
    const exported = `${this.prefixes[item.store] || ''}${item.stem}`;
    fs.mkdirSync(path.join(this.outDir, 'sections'), { recursive: true });
    fs.writeFileSync(path.join(this.outDir, 'sections', `${exported}.liquid`), `${injection}${source}`);
    this.packFiles.add(`sections/${exported}.liquid`);
    if (item.store !== this.baseStore) this.authoredFiles.add(`sections/${exported}.liquid`);
    this.processQueue();
    return exported;
  }

  validate() {
    const snippets = new Set(fs.existsSync(path.join(this.outDir, 'snippets')) ? fs.readdirSync(path.join(this.outDir, 'snippets')).filter((f) => f.endsWith('.liquid')).map((f) => f.replace(/\.liquid$/, '')) : []);
    const sections = new Set(fs.existsSync(path.join(this.outDir, 'sections')) ? fs.readdirSync(path.join(this.outDir, 'sections')).filter((f) => f.endsWith('.liquid')).map((f) => f.replace(/\.liquid$/, '')) : []);
    const blocks = new Set(fs.existsSync(path.join(this.outDir, 'blocks')) ? fs.readdirSync(path.join(this.outDir, 'blocks')).filter((f) => f.endsWith('.liquid')).map((f) => f.replace(/\.liquid$/, '')) : []);
    const assets = new Set(fs.existsSync(path.join(this.outDir, 'assets')) ? listFiles(path.join(this.outDir, 'assets')).map((f) => f.rel) : []);
    const errors = [];
    for (const item of this.missing) {
      // A dependency the base theme never had is a pre-existing gap, not something
      // this export introduced, so it warns instead of blocking the upload.
      if (item.store === this.baseStore && this.mode === 'theme') this.warnings.push(`Missing base theme ${item.kind}: ${item.name} (referenced by a selected base section)`);
      else errors.push(`Missing ${item.kind}: ${item.name}`);
    }
    const check = (dir, files) => {
      for (const file of files) {
        if (!file.endsWith('.liquid')) continue;
        // Only content this export actually authored (a foreign store's files) is a
        // hard error. Pre-existing gaps in the base theme are warnings, because the
        // export did not introduce them and must not be blocked by them.
        const rel = path.posix.join(dir, file);
        const authored = this.authoredFiles.has(rel);
        const report = authored ? errors : this.warnings;
        const label = authored ? '' : 'base theme ';
        const source = fs.readFileSync(path.join(this.outDir, dir, file), 'utf8');
        for (const name of extractSnippetRefs(source)) if (!snippets.has(name)) report.push(`Missing ${label}snippet: ${name} (in ${dir}/${file})`);
        for (const name of extractAssetRefs(source)) if (!assets.has(name)) report.push(`Missing ${label}asset: ${name} (in ${dir}/${file})`);
        const blockPattern = /\bcontent_for\s+(['"])block\1[\s\S]{0,500}?\btype\s*:\s*(['"])([\w-]+)\2/gi;
        let match;
        while ((match = blockPattern.exec(source))) if (!blocks.has(match[3])) report.push(`Missing ${label}block: ${match[3]} (in ${dir}/${file})`);
      }
    };
    check('sections', fs.existsSync(path.join(this.outDir, 'sections')) ? fs.readdirSync(path.join(this.outDir, 'sections')) : []);
    check('snippets', fs.existsSync(path.join(this.outDir, 'snippets')) ? fs.readdirSync(path.join(this.outDir, 'snippets')) : []);
    check('blocks', fs.existsSync(path.join(this.outDir, 'blocks')) ? fs.readdirSync(path.join(this.outDir, 'blocks')) : []);
    for (const file of listFiles(path.join(this.outDir, 'templates'))) {
      if (!file.rel.endsWith('.json')) continue;
      let template;
      try { template = JSON.parse(fs.readFileSync(file.full, 'utf8')); } catch { errors.push(`Invalid template JSON: ${file.rel}`); continue; }
      for (const section of Object.values(template.sections || {})) {
        if (section && !sections.has(section.type)) errors.push(`Template references missing section: ${section.type}`);
      }
    }
    return [...new Set(errors)];
  }
}

function resolveItems(items, baseStore, customDir) {
  if (!Array.isArray(items) || !items.length) throw new Error('Select at least one section');
  if (items.length > MAX_ITEMS) throw new Error(`Select no more than ${MAX_ITEMS} sections`);
  const seen = new Set();
  const prefixes = storePrefixes(items.map((item) => item.store), baseStore);
  return items.map((item) => {
    if (!item || typeof item.store !== 'string' || typeof item.file !== 'string' || !SAFE_SECTION.test(item.file)) throw new Error('Invalid section selection');
    const key = `${item.store}/${item.file}`;
    if (seen.has(key)) throw new Error('The same section was selected twice');
    seen.add(key);
    const stem = item.file.replace(/\.liquid$/, '');
    if (item.store === 'custom') {
      const slug = stem;
      const source = path.join(customDir, `${slug}.liquid`);
      let sourceText = '';
      try { sourceText = fs.readFileSync(source, 'utf8'); } catch {}
      if (!sourceText.trim()) throw new Error(`Custom section not found: ${key}`);
      return { ...item, stem, sourceText, name: slug, prefix: prefixes.custom || 'custom--' };
    }
    const storePath = findStore(item.store);
    if (!storePath) throw new Error(`Store not found: ${item.store}`);
    const source = path.join(storePath, 'sections', item.file);
    if (path.dirname(source) !== path.join(storePath, 'sections') || !fs.existsSync(source)) throw new Error(`Section not found: ${key}`);
    const sourceText = fs.readFileSync(source, 'utf8');
    if (!sourceText.trim()) throw new Error(`Section is empty: ${key}`);
    return { ...item, stem, sourceText, name: stem, prefix: prefixes[item.store] || '' };
  });
}

function manifestFor({ mode, baseStore, name, items, exported, warnings, sourceCommit, baseCore, baseDropped, orphansDropped }) {
  return {
    format: 'section-pack',
    version: 1,
    mode,
    name,
    baseStore,
    sourceCommit: sourceCommit || null,
    createdAt: new Date().toISOString(),
    sections: items.map((item, index) => ({ order: index + 1, store: item.store, file: item.file, exportedAs: `${exported[index]}.liquid` })),
    ...(mode === 'theme' ? { baseCoreSections: baseCore, baseDroppedSections: baseDropped, unusedFilesDropped: orphansDropped } : {}),
    warnings,
  };
}

function readmeFor(mode, manifest) {
  if (mode === 'theme') {
    const dropped = manifest.baseDroppedSections || [];
    return `# ${manifest.name}\n\nUpload this ZIP in Shopify Admin > Themes > Add theme > Upload zip file.\n\nThe generated \`templates/index.json\` already uses the selected section order. A matching \`page.section-pack\` template is included for previewing the pack on a page.\n\nLayout, config, locales, templates, snippets, assets, and blocks are the ${manifest.baseStore} theme's own files, unmodified. \`sections/\` holds the ${manifest.baseCoreSections.length} sections the theme needs to function (header, footer, cart, product, account, search, and the rest) plus your selection.${dropped.length ? ` The ${dropped.length} unused base content sections were left out; they are listed in \`section-pack.json\`.` : ''}\n`;
  }
  return `# ${manifest.name}\n\nThis lightweight pack contains selected section files and their required dependencies.\n\nCopy the contents into an existing Shopify theme, preserving the folder structure. Review INSTALL notes and warnings in section-pack.json before publishing.\n`;
}

function buildExport({ items, mode = 'theme', baseStore = BASE_STORE, name = 'section-pack', customDir, sourceCommit } = {}) {
  if (!['theme', 'pack'].includes(mode)) throw new Error('Invalid export mode');
  const resolvedBase = baseStore || BASE_STORE;
  if (!findStore(resolvedBase)) throw new Error(`Base store not found: ${resolvedBase}`);
  const resolved = resolveItems(items, resolvedBase, customDir);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'section-pack-'));
  let coreDropped = [];
  let orphansDropped = [];
  try {
    if (mode === 'theme') {
      const basePath = findStore(resolvedBase);
      copyTheme(basePath, outDir);
      coreDropped = pruneSections(outDir, coreSectionTypes(basePath));
    } else {
      for (const dir of ['sections', 'snippets', 'assets', 'blocks']) fs.mkdirSync(path.join(outDir, dir), { recursive: true });
    }
    const builder = new ExportBuilder({ outDir, baseStore: resolvedBase, items: resolved, prefixes: storePrefixes(resolved.map((item) => item.store), resolvedBase), mode });
    const exported = resolved.map((item) => builder.addSection(item));
    if (mode === 'theme') {
      const templateSections = {};
      const order = [];
      resolved.forEach((item, index) => {
        if (order.length >= MAX_SECTIONS_PER_TEMPLATE) return;
        const schema = extractSchema(item.sourceText);
        if (/{%-?\s*schema\s*-?%}/i.test(item.sourceText) && !schema) throw new Error(`Invalid schema in ${item.store}/${item.file}`);
        const body = templateSectionBody(schema);
        body.type = exported[index];
        for (const block of Object.values(body.blocks || {})) {
          if (block && block.type) block.type = builder.blockExportName(item.store, block.type);
        }
        const id = `pack_${String(index + 1).padStart(2, '0')}_${slugify(item.stem)}`;
        templateSections[id] = body;
        order.push(id);
      });
      if (resolved.length > MAX_SECTIONS_PER_TEMPLATE) {
        builder.warnings.push(`Only the first ${MAX_SECTIONS_PER_TEMPLATE} of ${resolved.length} selected sections were placed in templates/index.json (Shopify renders at most ${MAX_SECTIONS_PER_TEMPLATE} sections per template). All ${resolved.length} are still in sections/ and can be added in the theme editor.`);
      }
      const template = { sections: templateSections, order };
      fs.writeFileSync(path.join(outDir, 'templates', 'index.json'), JSON.stringify(template, null, 2));
      fs.writeFileSync(path.join(outDir, 'templates', 'page.section-pack.json'), JSON.stringify(template, null, 2));
      orphansDropped = pruneOrphans(outDir, builder.packFiles);
    }
    builder.finalizeAssets();
    const errors = builder.validate();
    if (mode === 'theme') {
      const store = validateThemeStore(outDir);
      errors.push(...store.errors);
      builder.warnings.push(...store.warnings);
    }
    if (errors.length) throw new Error(`Export validation failed: ${[...new Set(errors)].slice(0, 6).join('; ')}`);
    const baseCore = mode === 'theme' ? [...coreSectionTypes(findStore(resolvedBase))].sort() : [];
    const manifest = manifestFor({ mode, baseStore: resolvedBase, name, items: resolved, exported, warnings: builder.warnings, sourceCommit, baseCore, baseDropped: coreDropped.sort(), orphansDropped: orphansDropped.sort() });
    fs.writeFileSync(path.join(outDir, 'section-pack.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(outDir, 'README.md'), readmeFor(mode, manifest));
    return { buffer: zipDirectory(outDir), manifest, warnings: builder.warnings };
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

module.exports = { buildExport, MAX_ITEMS };
