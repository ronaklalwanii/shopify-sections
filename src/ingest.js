// Ingest: scan all store roots, parse section schemas, classify, dedupe, write data/index.json
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ROOTS } = require('./roots');
const { parseJsonLoose, extractSchema, collectSectionDependencies } = require('./section-meta');

const OUT_FILE = path.resolve(__dirname, '../data/index.json');
const OVERRIDES_FILE = path.resolve(__dirname, '../data/tag-overrides.json');
const QA_REPORT = path.resolve(__dirname, '../data/qa-report.json');

function loadOverrides() {
  try { return JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8')); } catch { return {}; }
}

// Store plumbing every Shopify theme must ship — page templates, drawers, and
// utilities. Hidden behind the "show core Shopify files" toggle.
const CORE_RULES = [
  /^main-/, 'drawer', 'search-drawer', 'pickup', 'privacy', 'promo-payment',
  'recently-viewed', 'related-products', 'apps', 'custom-liquid', 'custom-html',
  'shogun', 'account', 'password', 'gift-card', 'variant-added', 'newsletter-popup',
];

// [category, keywords] — first match wins. Checked top to bottom.
const CATEGORY_RULES = [
  ['Stats', ['stats', 'achievement', 'impact', 'countdown']],
  ['Testimonials', ['testimonial', 'review']],
  ['Trust / Social proof', ['trust', 'usp', 'badge', 'press', 'logo-list', 'why-buy', 'why-us', 'brand-value', 'the-problem', 'the-reality', 'the-solution', 'commitment', 'pillar', 'feature-chart']],
  ['Product showcase', ['product', 'collection', 'bundle', 'upsell', 'gift-set', 'buy-box']],
  ['Hero / Banner', ['hero', 'banner', 'slideshow', 'coverflow', 'statement', 'arena-process']],
  ['Media', ['video', 'image', 'media', 'gallery', 'before-after', 'carousel', 'hot-spots']],
  ['CTA / Newsletter', ['cta', 'newsletter', 'contact', 'booking', 'subscribe']],
  ['Header / Footer / Nav', ['footer', 'header', 'announcement', 'navigator', 'mega-header']],
  ['Text / Content', ['rich-text', 'multi-column', 'accordion', 'tabs', 'faq', 'editorial', 'story', 'flip', 'about', 'text-with-icons', 'bento', 'grid', 'card', 'decorated', 'button', 'glow', 'process', 'services', 'paths', 'scrolling', 'word-scroll', 'duo', 'layout', 'categories', 'accessories', 'link']],
];

function classify(fileName, overrides, context = {}) {
  const n = fileName.toLowerCase();
  if (overrides.category) return { category: overrides.category, core: overrides.core ?? false };
  const { referenced = false, signals = null } = context;
  // Ground truth first: a section the theme's own layout or a section group
  // renders is chrome by definition. Filename rules are the fallback, which is
  // what keeps utilities like custom-liquid flagged as core even though no
  // layout references them.
  const core = referenced || CORE_RULES.some((r) => (r instanceof RegExp ? r.test(n) : n.includes(r)));
  let category = 'Other';
  if (core) {
    category = /^main-|search|pickup|account|password|gift-card|cart|privacy|apps/.test(n) ? 'Core Shopify files' : 'Header / Footer / Nav';
    if (/drawer|search|pickup|privacy|promo-payment|recently-viewed|related|apps|custom-liquid|custom-html|shogun|newsletter-popup|variant-added/.test(n)) category = 'Core Shopify files';
    return { category, core };
  }
  for (const [cat, kws] of CATEGORY_RULES) {
    if (kws.some((k) => n.includes(k))) { category = cat; break; }
  }
  // A keyword match is a confident label, so signals only get to rescue the
  // sections the filename rules could not place. Overruling a confident match
  // with a weak signal made labels worse - a contact form read as core
  // plumbing, a video hero was relabelled Media - so it is deliberately not done.
  if (category === 'Other' && signals) {
    const fromSignals = signalCategory(signals);
    if (fromSignals) category = fromSignals;
  }
  return { category, core };
}

// What the section actually does, read from its schema and its Liquid rather
// than guessed from its filename.
function deriveSignals(src, schema) {
  const settings = (schema && schema.settings) || [];
  const blocks = (schema && schema.blocks) || [];
  const dataObjects = [];
  for (const object of ['product', 'cart', 'collection', 'blog', 'article', 'customer', 'order', 'shop', 'predictive_search', 'localization']) {
    if (new RegExp(`\\b${object}\\s*\\.`, 'i').test(src)) dataObjects.push(object);
  }
  const settingTypes = {};
  for (const setting of settings) if (setting && setting.type) settingTypes[setting.type] = true;
  return {
    dataObjects,
    // Unique type names, not counts: this is for search and display, and the
    // index is held in memory and served to the browser, so it stays compact.
    settingTypes: Object.keys(settingTypes),
    blockTypes: blocks.map((b) => b && b.type).filter(Boolean),
    hasProductForm: /\{%-?\s*form\s+['"]product['"]/.test(src),
    hasCartForm: /\{%-?\s*form\s+['"]cart['"]/.test(src),
    hasVideo: /<video|\.mp4|\.m3u8|video_url|external_video/.test(src),
    hasMediaSetting: ['image', 'video', 'richtext'].some((t) => settingTypes[t]),
    usesRichtext: !!settingTypes.richtext,
    usesBlocks: blocks.length > 0 || /content_for\s+['"]block['"]/i.test(src),
    usesSnippet: /\{%-?\s*(?:render|include)\s+/.test(src),
    usesRemoteAsset: /https?:\/\//.test(src) && !/https?:\/\/(?:cdn\.shopify\.com|fonts\.|\/\/)/.test(src),
  };
}

// Only unambiguous evidence, and only ever used for sections the filename rules
// could not place. A {% form 'product' %} really does mean it sells something.
function signalCategory(signals) {
  const { dataObjects, settingTypes } = signals;
  if (signals.hasProductForm || signals.hasCartForm) return 'Product showcase';
  if (dataObjects.includes('blog') || dataObjects.includes('article')) return 'Text / Content';
  if (signals.usesRichtext && !signals.hasMediaSetting && settingTypes.length <= 3) return 'Text / Content';
  return null;
}

// The sections a store's chrome is built from: the ones its layout renders
// statically or through a section group. Deliberately excludes page templates,
// because a page template referencing collection-banner or contact means those
// are that page's content, not store plumbing. (The exporter keeps a wider set
// for a different reason: anything a template references must survive export.)
function chromeSectionTypes(storeDir) {
  const referenced = new Set();
  const sectionsDir = path.join(storeDir, 'sections');
  const addGroup = (name) => {
    try {
      const data = parseJsonLoose(fs.readFileSync(path.join(sectionsDir, `${name}.json`), 'utf8'));
      for (const section of Object.values((data && data.sections) || {})) if (section && section.type) referenced.add(section.type);
    } catch {}
  };
  try {
    for (const entry of fs.readdirSync(sectionsDir)) if (entry.endsWith('.json')) addGroup(entry.replace(/\.json$/, ''));
  } catch {}
  try {
    for (const entry of fs.readdirSync(path.join(storeDir, 'layout'))) {
      if (!entry.endsWith('.liquid')) continue;
      const text = fs.readFileSync(path.join(storeDir, 'layout', entry), 'utf8');
      for (const match of text.matchAll(/\{%-?\s*section\s+(['"])([^'"]+)\1/g)) referenced.add(match[2]);
      for (const match of text.matchAll(/\{%-?\s*sections\s+(['"])([^'"]+)\1/g)) addGroup(match[2]);
    }
  } catch {}
  return referenced;
}


function contentHash(src) {
  const norm = src.replace(/\r/g, '').split('\n').map((l) => l.trimEnd()).join('\n').trim();
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

/* ------------------------------ store brand color ----------------------------- */

const FALLBACK_PALETTE = ['#2f6f8f', '#c2571f', '#2f8f5b', '#8f2f6b', '#b39322', '#5b5bd6', '#c2478f', '#5d6b7a', '#6b7a2f', '#b3382f', '#3f7fae', '#7a5d8a'];

function hexSaturation(hex) {
  const m = hex.replace('#', '');
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

function luminance(hex) {
  const m = hex.replace('#', '');
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function storeBrandColor(storeDir) {
  let colors = [];
  try {
    const data = parseJsonLoose(fs.readFileSync(path.join(storeDir, 'config/settings_data.json'), 'utf8')) || {};
    const cur = data.current || {};
    colors = Object.entries(cur)
      .filter(([, v]) => typeof v === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v))
      .map(([k, v]) => ({ key: k.toLowerCase(), hex: v }));
  } catch {}
  // prefer explicit accent/primary/button keys, else the most saturated color
  const named = colors.find((c) => /accent|primary|brand|button_?(bg|background|color)?$/.test(c.key) && !/text|label|border|icon|hover/.test(c.key));
  if (named && hexSaturation(named.hex) > 0.12) return named.hex;
  const best = colors
    .map((c) => ({ ...c, sat: hexSaturation(c.hex) }))
    .sort((a, b) => b.sat - a.sat)[0];
  if (best && best.sat > 0.2) return best.hex;
  const hash = crypto.createHash('md5').update(path.basename(storeDir)).digest('hex');
  return FALLBACK_PALETTE[parseInt(hash.slice(0, 4), 16) % FALLBACK_PALETTE.length];
}

function ingestStore(root, storeDir) {
  const sectionsDir = path.join(storeDir, 'sections');
  if (!fs.existsSync(sectionsDir)) return null;
  const sections = [];
  const referenced = chromeSectionTypes(storeDir);
  for (const f of fs.readdirSync(sectionsDir).sort()) {
    if (!f.endsWith('.liquid')) continue;
    const full = path.join(sectionsDir, f);
    const src = fs.readFileSync(full, 'utf8');
    const schema = extractSchema(src);
    const dependencies = collectSectionDependencies(storeDir, src);
    const schemaStatus = schema ? 'valid' : /{%-?\s*schema\s*-?%}/i.test(src) ? 'invalid' : 'missing';
    const slug = f.replace(/\.liquid$/, '');
    sections.push({
      store: path.basename(storeDir),
      root,
      file: f,
      slug,
      name: (schema && schema.name) || slug.replace(/[-_]/g, ' '),
      category: null,
      settings: schema ? (schema.settings || []).length : 0,
      blocks: schema ? (schema.blocks || []).length : 0,
      hasPresets: !!(schema && schema.presets && schema.presets.length),
      lines: src.split('\n').length,
      assets: dependencies.assets,
      dependencies,
      hasSchema: !!schema,
      schemaStatus,
      usesContentFor: /\bcontent_for\b/i.test(src),
      empty: src.trim().length === 0,
      hash: contentHash(src),
      // Ground truth for "is this store plumbing", plus what the code does.
      referenced: referenced.has(slug),
      signals: deriveSignals(src, schema),
    });
  }
  return sections;
}

function loadQaIndex(reportPath = QA_REPORT) {
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const mapRows = (rows = []) => new Map(rows.map((row) => [`${row.store}/${row.file}`, row]));
    return { checkedAt: report.generatedAt || null, local: mapRows(report.local?.results), live: mapRows(report.live?.results) };
  } catch { return { checkedAt: null, local: new Map(), live: new Map() }; }
}

function applyQuality(sections, reportPath) {
  const report = loadQaIndex(reportPath);
  const byKey = new Map(sections.map((section) => [`${section.store}/${section.file}`, section]));
  for (const section of sections) {
    let key = `${section.store}/${section.file}`;
    if (!report.local.has(key) && !report.live.has(key) && section.canonical && byKey.has(section.canonical)) key = section.canonical;
    const rows = [report.local.get(key), report.live.get(key)].filter(Boolean);
    const issues = rows.flatMap((row) => row.issues || []);
    const status = !rows.length ? 'unverified' : rows.some((row) => row.status === 'fail') ? 'failed'
      : rows.some((row) => row.status === 'warn') ? 'review' : 'checked';
    section.quality = { status, issues: [...new Set(issues)], checkedAt: rows.length ? report.checkedAt : null };
  }
}

function ingestIndex({ outFile = OUT_FILE, roots = ROOTS, overrides = loadOverrides(), quiet = false } = {}) {
  const stores = [];
  const sections = [];
  for (const root of roots) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const ingested = ingestStore(root, path.join(root, entry.name));
      if (!ingested) continue;
      const color = storeBrandColor(path.join(root, entry.name));
      stores.push({ name: entry.name, sectionCount: ingested.length, color, textColor: luminance(color) > 0.6 ? '#191a1c' : '#ffffff' });
      for (const s of ingested) {
        const ov = overrides[`${s.store}/${s.file}`] || {};
        const { category, core } = classify(s.file, ov, { referenced: s.referenced, signals: s.signals });
        s.category = category;
        s.core = core;
        s.custom = false;
        sections.push(s);
      }
    }
  }

  // Cross-store dedupe: identical content across stores collapses to one entry.
  const groups = new Map();
  for (const s of sections) {
    if (!groups.has(s.hash)) groups.set(s.hash, []);
    groups.get(s.hash).push(s);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => (a.store + a.file).localeCompare(b.store + b.file));
    const canonical = group[0];
    canonical.group = group.map((s) => s.store);
    for (const s of group.slice(1)) {
      s.duplicate = true;
      s.canonical = `${canonical.store}/${canonical.file}`;
      s.group = canonical.group;
    }
  }

  // Variant grouping: same slug across stores. Content-hash dedupe cannot see
  // these, because a modified or extended version is by definition a different
  // hash - which is exactly the interesting case. Groups with a single distinct
  // hash are exact copies and carry no new information.
  //
  // The variant list is stored once per slug at the top level rather than on
  // every member: announcement-bar alone spans 24 stores, and duplicating that
  // array on each of them was the difference between a 1.5 MB and a 4 MB index.
  const bySlug = new Map();
  for (const s of sections) {
    if (!bySlug.has(s.slug)) bySlug.set(s.slug, []);
    bySlug.get(s.slug).push(s);
  }
  const variants = {};
  for (const [slug, group] of bySlug) {
    if (group.length < 2) continue;
    group.sort((a, b) => (a.store + a.file).localeCompare(b.store + b.file));
    const list = [];
    const seenHashes = new Set();
    for (const s of group) {
      if (seenHashes.has(s.hash)) continue;
      seenHashes.add(s.hash);
      list.push({ store: s.store, file: s.file, hash: s.hash, lines: s.lines, settings: s.settings, blocks: s.blocks, stores: group.filter((o) => o.hash === s.hash).map((o) => o.store) });
    }
    if (list.length < 2) continue;
    variants[slug] = { stores: group.length, variants: list };
    for (const s of group) {
      s.variantSlug = slug;
      s.variantCount = list.length;
      s.diverged = true;
    }
  }

  for (const s of sections) delete s.root;
  const version = crypto.createHash('sha256').update(JSON.stringify({ stores, sections })).digest('hex').slice(0, 16);
  applyQuality(sections, overrides.qualityReport);
  const index = { version, stores, variants, sections };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(index, null, 2));
  if (!quiet) {
    const byCat = {};
    let dupes = 0;
    for (const s of sections) { byCat[s.category] = (byCat[s.category] || 0) + 1; if (s.duplicate) dupes++; }
    console.log(`Ingested ${sections.length} sections from ${stores.length} store(s) across ${roots.length} root(s)`);
    console.log(`Duplicates collapsed: ${dupes} (${groups.size} unique components)`);
    console.log(byCat);
  }
  return { index, stores, sections, variants, groups };
}

function main() {
  ingestIndex();
}

if (require.main === module) main();
module.exports = { main, ingestIndex, extractSchema };
