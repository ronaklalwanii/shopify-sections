// Merge all shopify-stores/* themes into one "gallery theme":
//  - every section copied with a store prefix, its snippet/asset deps rewritten
//  - each store's global CSS + design tokens injected at the top of its sections
//  - one JSON template per section => stable URL: /pages/<page>?view=<template>
// Output: gallery-theme/ + gallery-theme.zip + data/gallery-manifest.json
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { findStore } = require('./roots');
const OUT = path.resolve(__dirname, '../gallery-theme');
const HOST = process.env.HOST_STORE || 'base'; // provides layout, config, locales skeleton

const ASSET_EXT = /\.(css|mjs|js|woff2?|png|jpe?g|svg|gif|webp|avif|eot|ttf|otf)(\?.*)?$/i;

const prefixFor = (store) => (store === HOST ? '' : store.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '--');
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/* ------------------------------- store scanning ------------------------------ */

function readStoreLayoutDeps(store) {
  const storePath = findStore(store);
  const css = [], js = [], snippets = [], styleBlocks = [];
  const scan = (text) => {
    let m;
    const cssRe = /['"]([\w./-]+\.css)['"]\s*\|\s*asset_url/g;
    while ((m = cssRe.exec(text))) if (!css.includes(m[1])) css.push(m[1]);
    const jsRe = /['"]([\w./-]+\.js)['"]\s*\|\s*asset_url/g;
    while ((m = jsRe.exec(text))) if (!js.includes(m[1])) js.push(m[1]);
    const snipRe = /{%-?\s*render\s+'([\w-]+)'/g;
    while ((m = snipRe.exec(text))) if (!snippets.includes(m[1])) snippets.push(m[1]);
  };
  let layout = '';
  try { layout = fs.readFileSync(path.join(storePath, 'layout/theme.liquid'), 'utf8'); } catch { return { css, js, snippets, styleBlocks }; }
  scan(layout);
  // inline design tokens defined in the layout itself (some themes don't use a snippet)
  for (const m of layout.matchAll(/{%-?\s*style\s*-?%}([\s\S]*?){%-?\s*endstyle\s*-?%}/g)) styleBlocks.push(m[1]);
  for (const m of layout.matchAll(/<style>([\s\S]*?)<\/style>/g)) styleBlocks.push(m[1]);
  for (const s of snippets) {
    try { scan(fs.readFileSync(path.join(storePath, 'snippets', `${s}.liquid`), 'utf8')); } catch {}
  }
  return { css, js, snippets, styleBlocks };
}

/* ------------------------------ dependency graph ----------------------------- */

// Rewrite snippet renders + asset_url refs of a liquid source to prefixed names,
// queueing copies of any dependency we don't have yet.
class Copier {
  constructor(store) {
    this.store = store;
    this.prefix = prefixFor(store);
    this.storePath = findStore(store);
    this.queue = [];            // [{kind:'snippet'|'asset', name}]
    this.copied = new Set();    // prefixed names already handled
  }

  rewrite(source) {
    // snippet renders: {% render 'name' ... %} / include
    source = source.replace(
      /({%-?\s*(?:render|include)\s+)(')([\w-]+)(')/g,
      (full, lead, q1, name, q2) => {
        if (this.hasStoreSnippet(name)) {
          this.enqueue('snippet', name);
          return `${lead}${q1}${this.prefix}${name}${q2}`;
        }
        return full; // store doesn't have it — leave for host theme to resolve
      },
    );
    // assets: 'file.ext' | asset_url
    source = source.replace(
      /(['"])([\w./-]+\.(?:css|mjs|js|woff2?|png|jpe?g|svg|gif|webp|avif|eot|ttf|otf))\1\s*\|\s*asset_url/g,
      (full, q1, file) => {
        this.enqueue('asset', file);
        return `${q1}${this.prefix}${file}${q1} | asset_url`;
      },
    );
    return source;
  }

  hasStoreSnippet(name) { return fs.existsSync(path.join(this.storePath, 'snippets', `${name}.liquid`)); }

  enqueue(kind, name) {
    const prefixed = `${this.prefix}${name}`;
    if (this.copied.has(prefixed)) return;
    this.copied.add(prefixed);
    this.queue.push({ kind, name, prefixed });
  }

  drain() {
    while (this.queue.length) {
      const { kind, name, prefixed } = this.queue.shift();
      const src = kind === 'snippet'
        ? path.join(this.storePath, 'snippets', `${name}.liquid`)
        : path.join(this.storePath, 'assets', name);
      if (!fs.existsSync(src)) continue;
      const dest = kind === 'snippet'
        ? path.join(OUT, 'snippets', `${prefixed}.liquid`)
        : path.join(OUT, 'assets', prefixed);
      if (kind === 'snippet') {
        const body = this.rewrite(fs.readFileSync(src, 'utf8'));
        fs.writeFileSync(dest, body);
      } else {
        fs.copyFileSync(src, dest);
      }
    }
  }
}

/* --------------------------- template JSON generation ------------------------- */

function sectionSettingsFor(schema) {
  // Schema defaults + first preset — the same defaulting the preview renderer does.
  const settings = {};
  const keep = (v) => v != null && typeof v !== 'object' && !(typeof v === 'string' && ASSET_EXT.test(v));
  for (const s of schema?.settings || []) {
    if (!s.id) continue;
    if (['image_picker', 'font_picker', 'link_list', 'collection', 'product', 'blog', 'page', 'article', 'video', 'video_url', 'color_scheme_group', 'color_background'].includes(s.type)) continue;
    if (keep(s.default)) settings[s.id] = s.default;
  }
  const preset = (schema?.presets || [])[0];
  if (preset?.settings) {
    for (const [k, v] of Object.entries(preset.settings)) {
      if (keep(v)) settings[k] = v;
    }
  }
  return { settings, preset };
}

function parseSchemaLoose(body) {
  // Shopify tolerates trailing commas in {% schema %}; JSON.parse doesn't.
  try { return JSON.parse(body); } catch {}
  try { return JSON.parse(body.replace(/,(\s*[}\]])/g, '$1')); } catch { return null; }
}

function templateSectionBody(schema) {
  const { settings, preset } = sectionSettingsFor(schema);
  const blocks = {};
  const order = [];
  const blockDefs = schema?.blocks || [];
  const defFor = (type) => blockDefs.find((b) => b.type === type);
  let blockSettings = (type, from) => {
    const out = {};
    const def = defFor(type);
    for (const s of def?.settings || []) {
      if (!s.id) continue;
      if (['image_picker', 'font_picker', 'link_list', 'collection', 'product', 'blog', 'page', 'article', 'video', 'video_url'].includes(s.type)) continue;
      if (s.default != null && typeof s.default !== 'object') out[s.id] = s.default;
    }
    if (from?.settings) {
      for (const [k, v] of Object.entries(from.settings)) {
        if (v != null && typeof v !== 'object' && !(typeof v === 'string' && ASSET_EXT.test(v))) out[k] = v;
      }
    }
    return out;
  };
  const addBlock = (type, from) => {
    if (type === '@app' || !defFor(type)) return;
    const id = `bl-${order.length + 1}`;
    blocks[id] = { type, settings: blockSettings(type, from) };
    order.push(id);
  };
  if (preset?.blocks?.length) {
    for (const b of preset.blocks.slice(0, 20)) addBlock(b.type, b);
  } else {
    for (const def of blockDefs.slice(0, 8)) {
      if (def.type === '@app') continue;
      const n = Math.min(def.limit || 2, 2);
      for (let i = 0; i < n; i++) addBlock(def.type, null);
    }
  }
  const body = { type: null, settings };
  if (order.length) { body.blocks = blocks; body.block_order = order; }
  return body;
}

/* ----------------------------------- main ------------------------------------ */

function main() {
  const index = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/index.json'), 'utf8'));
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.cpSync(findStore(HOST), OUT, { recursive: true });
  // keep the host's own JSON templates (index, product, 404, ...) so the store
  // works normally — our generated lib-* templates are added alongside them.

  const manifest = {};
  const gallerySnippets = path.join(OUT, 'snippets');

  for (const store of index.stores.map((s) => s.name)) {
    const deps = readStoreLayoutDeps(store);
    const copier = new Copier(store);

    // copy global css/js of the store so its sections can load them
    for (const f of deps.css) copier.enqueue('asset', f);
    // design tokens: prefer the css-variables-style snippet; else the layout's
    // inline {% style %} blocks (some themes define :root vars in the layout).
    let tokensSnippet = null;
    for (const name of deps.snippets) {
      if (/^(css-variables|css-vars|design-tokens|theme-styles-variables)$/.test(name)) { tokensSnippet = name; copier.enqueue('snippet', name); break; }
    }
    let tokensRender = null;
    if (tokensSnippet) {
      tokensRender = `{% render '${prefixFor(store)}${tokensSnippet}' %}`;
    } else if (deps.styleBlocks.join('\n').trim()) {
      const name = `${prefixFor(store)}layout-tokens`;
      fs.writeFileSync(path.join(gallerySnippets, `${name}.liquid`), copier.rewrite(deps.styleBlocks.join('\n')));
      tokensRender = `{% render '${name}' %}`;
    }

    const sectionsDir = path.join(findStore(store), 'sections');
    for (const file of fs.readdirSync(sectionsDir).sort()) {
      if (!file.endsWith('.liquid')) continue;
      const meta = index.sections.find((s) => s.store === store && s.file === file);
      if (!meta || meta.empty) continue;
      if (meta.duplicate) continue; // canonical section already covers this content

      let src = fs.readFileSync(path.join(sectionsDir, file), 'utf8');
      src = copier.rewrite(src);

      const prefixedName = `${prefixFor(store)}${file.replace(/\.liquid$/, '')}`;
      if (prefixFor(store)) {
        // load the store's global css + tokens before the section markup
        const head = [];
        for (const c of deps.css) head.push(`{{ '${prefixFor(store)}${c}' | asset_url | stylesheet_tag }}`);
        if (tokensRender) head.push(tokensRender);
        src = `{%- comment -%} Section Library: injected global assets for store "${store}" {%- endcomment -%}\n${head.join('\n')}\n${src}`;
      }

      fs.writeFileSync(path.join(OUT, 'sections', `${prefixedName}.liquid`), src);
      copier.drain();

      // template name: keep readable, hash if too long for Shopify's filename limits
      let tpl = `page.lib-${slugify(store)}-${slugify(file.replace(/\.liquid$/, ''))}`.slice(0, 60);
      if (tpl.length > 48) tpl = `page.lib-${require('crypto').createHash('md5').update(`${store}/${file}`).digest('hex').slice(0, 12)}`;
      const schemaMatch = src.match(/{%\s*schema\s*%}([\s\S]*?){%\s*endschema\s*%}/);
      const body = templateSectionBody(schemaMatch ? parseSchemaLoose(schemaMatch[1]) : null);
      body.type = prefixedName;
      fs.writeFileSync(path.join(OUT, 'templates', `${tpl}.json`), JSON.stringify({ sections: { library: body }, order: ['library'] }, null, 2));
      manifest[`${store}/${file}`] = { template: tpl.replace(/^page\./, ''), url: `/pages/section-library?view=${tpl.replace(/^page\./, '')}` };
    }
    copier.drain();
  }

  // default template for the page (simple rich text host page)
  fs.writeFileSync(path.join(OUT, 'templates/page.section-library.json'), JSON.stringify({
    sections: { main: { type: 'main-page' } },
    order: ['main'],
  }, null, 2));

  // minimal layout for preview templates — no header/footer groups, no chrome
  fs.writeFileSync(path.join(OUT, 'layout/library-preview.liquid'), `<!doctype html>
<html lang="{{ request.locale.iso_code }}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    {%- render 'css-variables' -%}
    {{ 'theme.css' | asset_url | stylesheet_tag }}
    {{ content_for_header }}
  </head>
  <body>
    {{ content_for_layout }}
  </body>
</html>
`);
  const applyLayout = (dir) => {
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith('page.lib-')) continue;
      const p = path.join(dir, f);
      const json = JSON.parse(fs.readFileSync(p, 'utf8'));
      json.layout = 'library-preview';
      fs.writeFileSync(p, JSON.stringify(json, null, 2));
    }
  };
  applyLayout(path.join(OUT, 'templates'));

  // merge foreign locales so | t lookups resolve (host wins conflicts)
  const localePath = path.join(OUT, 'locales/en.default.json');
  const locale = JSON.parse(fs.readFileSync(localePath, 'utf8'));
  const deepMerge = (into, from) => {
    for (const [k, v] of Object.entries(from || {})) {
      if (!(k in into)) into[k] = v;
      else if (typeof v === 'object' && v && typeof into[k] === 'object') deepMerge(into[k], v);
    }
  };
  for (const store of index.stores.map((s) => s.name)) {
    if (store === HOST) continue;
    try {
      const l = JSON.parse(fs.readFileSync(path.join(findStore(store), 'locales/en.default.json'), 'utf8'));
      deepMerge(locale, l);
    } catch {}
  }
  fs.writeFileSync(localePath, JSON.stringify(locale, null, 2));

  // duplicates share the canonical section's gallery URL
  for (const s of index.sections) {
    if (s.duplicate && manifest[s.canonical]) {
      manifest[`${s.store}/${s.file}`] = manifest[s.canonical];
    }
  }

  fs.mkdirSync(path.resolve(__dirname, '../data'), { recursive: true });
  fs.writeFileSync(path.resolve(__dirname, '../data/gallery-manifest.json'), JSON.stringify(manifest, null, 2));

  const count = (dir) => fs.existsSync(path.join(OUT, dir)) ? fs.readdirSync(path.join(OUT, dir)).length : 0;
  console.log(`Gallery theme built: ${count('sections')} sections, ${count('snippets')} snippets, ${count('assets')} assets, ${count('templates')} templates`);
  console.log(`Manifest entries: ${Object.keys(manifest).length}`);
  lint();
}

/* ----------------------------------- lint ------------------------------------ */

function lint() {
  const g = (d) => new Set(fs.existsSync(path.join(OUT, d)) ? fs.readdirSync(path.join(OUT, d)) : []);
  const snippets = g('snippets'), assets = g('assets'), sections = g('sections');
  let missingSnips = 0, missingAssets = 0;
  const checkDir = (dir, set) => {
    for (const f of set) {
      if (!f.endsWith('.liquid')) continue;
      const src = fs.readFileSync(path.join(OUT, dir, f), 'utf8');
      const snipRe = /{%-?\s*(?:render|include)\s+'([\w-]+)'/g;
      let m;
      while ((m = snipRe.exec(src))) {
        if (!snippets.has(`${m[1]}.liquid`)) { missingSnips++; if (missingSnips <= 8) console.log(`  missing snippet: ${m[1]} (used in ${dir}/${f})`); }
      }
      const assetRe = /['"]([\w./-]+\.(?:css|mjs|js|woff2?|png|jpe?g|svg|gif|webp|avif|eot|ttf|otf))['"]\s*\|\s*asset_url/g;
      while ((m = assetRe.exec(src))) {
        if (!assets.has(m[1])) { missingAssets++; if (missingAssets <= 8) console.log(`  missing asset: ${m[1]} (used in ${dir}/${f})`); }
      }
      if (dir === 'sections') {
        const sm = src.match(/{%\s*schema\s*%}([\s\S]*?){%\s*endschema\s*%}/);
        if (sm && !parseSchemaLoose(sm[1])) console.log(`  BAD SCHEMA JSON in ${f}`);
      }
    }
  };
  checkDir('sections', sections);
  checkDir('snippets', snippets);
  console.log(`Lint: ${missingSnips} missing snippet refs, ${missingAssets} missing asset refs`);
}

function zip() {
  const zipPath = path.resolve(__dirname, '../gallery-theme.zip');
  try { fs.rmSync(zipPath, { force: true }); } catch {}
  execFileSync('zip', ['-rq', zipPath, '.'], { cwd: OUT });
  const mb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
  console.log(`Zipped → gallery-theme.zip (${mb} MB)`);
}

main();
if (process.argv.includes('--zip')) zip();
