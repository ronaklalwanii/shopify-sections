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

function sanitizeBaseTemplates(outDir, availableTypes) {
  const templatesDir = path.join(outDir, 'templates');
  for (const file of listFiles(templatesDir)) {
    if (!file.rel.endsWith('.json') || file.rel === 'templates/index.json') continue;
    let data;
    try { data = JSON.parse(fs.readFileSync(file.full, 'utf8')); } catch { fs.rmSync(file.full, { force: true }); continue; }
    if (!data || typeof data !== 'object' || !data.sections || typeof data.sections !== 'object') continue;
    const sections = {};
    for (const [id, section] of Object.entries(data.sections)) {
      if (section && typeof section === 'object' && availableTypes.has(section.type)) sections[id] = section;
    }
    const order = (Array.isArray(data.order) ? data.order : Object.keys(sections)).filter((id) => sections[id]);
    if (!order.length) {
      fs.rmSync(file.full, { force: true });
      continue;
    }
    data.sections = sections;
    data.order = order;
    fs.writeFileSync(file.full, JSON.stringify(data, null, 2));
  }
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
      const destination = path.join(this.outDir, item.kind === 'asset' ? 'assets' : item.kind === 'block' ? 'blocks' : 'snippets', exportedFile);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
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
    this.processQueue();
    return exported;
  }

  validate() {
    const snippets = new Set(fs.existsSync(path.join(this.outDir, 'snippets')) ? fs.readdirSync(path.join(this.outDir, 'snippets')).filter((f) => f.endsWith('.liquid')).map((f) => f.replace(/\.liquid$/, '')) : []);
    const sections = new Set(fs.existsSync(path.join(this.outDir, 'sections')) ? fs.readdirSync(path.join(this.outDir, 'sections')).filter((f) => f.endsWith('.liquid')).map((f) => f.replace(/\.liquid$/, '')) : []);
    const blocks = new Set(fs.existsSync(path.join(this.outDir, 'blocks')) ? fs.readdirSync(path.join(this.outDir, 'blocks')).filter((f) => f.endsWith('.liquid')).map((f) => f.replace(/\.liquid$/, '')) : []);
    const assets = new Set(fs.existsSync(path.join(this.outDir, 'assets')) ? listFiles(path.join(this.outDir, 'assets')).map((f) => f.rel) : []);
    const errors = [...this.missing.map((item) => `Missing ${item.kind}: ${item.name}`)];
    const check = (dir, files) => {
      for (const file of files) {
        if (!file.endsWith('.liquid')) continue;
        const source = fs.readFileSync(path.join(this.outDir, dir, file), 'utf8');
        for (const name of extractSnippetRefs(source)) if (!snippets.has(name)) errors.push(`Missing snippet: ${name}`);
        for (const name of extractAssetRefs(source)) if (!assets.has(name)) errors.push(`Missing asset: ${name}`);
        const blockPattern = /\bcontent_for\s+(['"])block\1[\s\S]{0,500}?\btype\s*:\s*(['"])([\w-]+)\2/gi;
        let match;
        while ((match = blockPattern.exec(source))) if (!blocks.has(match[3])) errors.push(`Missing block: ${match[3]}`);
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

function manifestFor({ mode, baseStore, name, items, exported, warnings, sourceCommit }) {
  return {
    format: 'section-pack',
    version: 1,
    mode,
    name,
    baseStore,
    sourceCommit: sourceCommit || null,
    createdAt: new Date().toISOString(),
    sections: items.map((item, index) => ({ order: index + 1, store: item.store, file: item.file, exportedAs: `${exported[index]}.liquid` })),
    warnings,
  };
}

function readmeFor(mode, manifest) {
  if (mode === 'theme') return `# ${manifest.name}\n\nUpload this ZIP in Shopify Admin > Themes > Add theme > Upload zip file.\n\nThe generated \`templates/index.json\` already uses the selected section order. A matching \`page.section-pack\` template is included for previewing the pack on a page.\n`;
  return `# ${manifest.name}\n\nThis lightweight pack contains selected section files and their required dependencies.\n\nCopy the contents into an existing Shopify theme, preserving the folder structure. Review INSTALL notes and warnings in section-pack.json before publishing.\n`;
}

function buildExport({ items, mode = 'theme', baseStore = BASE_STORE, name = 'section-pack', customDir, sourceCommit } = {}) {
  if (!['theme', 'pack'].includes(mode)) throw new Error('Invalid export mode');
  const resolvedBase = baseStore || BASE_STORE;
  if (!findStore(resolvedBase)) throw new Error(`Base store not found: ${resolvedBase}`);
  const resolved = resolveItems(items, resolvedBase, customDir);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'section-pack-'));
  try {
    if (mode === 'theme') {
      copyTheme(findStore(resolvedBase), outDir);
      clearDirectory(path.join(outDir, 'sections'));
    } else {
      for (const dir of ['sections', 'snippets', 'assets', 'blocks']) fs.mkdirSync(path.join(outDir, dir), { recursive: true });
    }
    const builder = new ExportBuilder({ outDir, baseStore: resolvedBase, items: resolved, prefixes: storePrefixes(resolved.map((item) => item.store), resolvedBase), mode });
    const exported = resolved.map((item) => builder.addSection(item));
    if (mode === 'theme') {
      const templateSections = {};
      const order = [];
      resolved.forEach((item, index) => {
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
      const template = { sections: templateSections, order };
      fs.writeFileSync(path.join(outDir, 'templates', 'index.json'), JSON.stringify(template, null, 2));
      fs.writeFileSync(path.join(outDir, 'templates', 'page.section-pack.json'), JSON.stringify(template, null, 2));
      sanitizeBaseTemplates(outDir, new Set(exported));
    }
    builder.finalizeAssets();
    const errors = builder.validate();
    if (errors.length) throw new Error(`Export validation failed: ${errors.slice(0, 6).join('; ')}`);
    const manifest = manifestFor({ mode, baseStore: resolvedBase, name, items: resolved, exported, warnings: builder.warnings, sourceCommit });
    fs.writeFileSync(path.join(outDir, 'section-pack.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(outDir, 'README.md'), readmeFor(mode, manifest));
    return { buffer: zipDirectory(outDir), manifest, warnings: builder.warnings };
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

module.exports = { buildExport, MAX_ITEMS };
