// Ingest: scan all store roots, parse section schemas, classify, dedupe, write data/index.json
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ROOTS } = require('./roots');
const { parseJsonLoose } = require('./renderer');

const OUT_FILE = path.resolve(__dirname, '../data/index.json');
const OVERRIDES_FILE = path.resolve(__dirname, '../data/tag-overrides.json');

function loadOverrides() {
  try { return JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8')); } catch { return {}; }
}

// Page-level chrome & utilities — hidden behind "show functional" toggle.
const FUNCTIONAL_RULES = [
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

function classify(fileName, overrides) {
  const n = fileName.toLowerCase();
  if (overrides.category) return { category: overrides.category, functional: overrides.functional ?? false };
  const functional = FUNCTIONAL_RULES.some((r) => (r instanceof RegExp ? r.test(n) : n.includes(r)));
  let category = 'Other';
  if (functional) {
    category = /^main-|search|pickup|account|password|gift-card|cart|privacy|apps/.test(n) ? 'Functional / page' : 'Header / Footer / Nav';
    if (/drawer|search|pickup|privacy|promo-payment|recently-viewed|related|apps|custom-liquid|custom-html|shogun|newsletter-popup|variant-added/.test(n)) category = 'Functional / page';
  } else {
    for (const [cat, kws] of CATEGORY_RULES) {
      if (kws.some((k) => n.includes(k))) { category = cat; break; }
    }
  }
  return { category, functional };
}

function extractSchema(src) {
  const m = src.match(/{%\s*schema\s*%}([\s\S]*?){%\s*endschema\s*%}/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// External assets referenced via asset_url/stylesheet_tag/script_tag in the Liquid.
function extractAssetRefs(src) {
  const refs = new Set();
  const re = /['"]([\w./-]+\.(?:css|js))['"]\s*\|\s*(?:asset_url|shopify_asset_url|stylesheet_tag|script_tag|preload_tag)/g;
  let m;
  while ((m = re.exec(src))) refs.add(m[1]);
  return [...refs];
}

// Content fingerprint for cross-store dedupe (whitespace-insensitive).
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
  for (const f of fs.readdirSync(sectionsDir).sort()) {
    if (!f.endsWith('.liquid')) continue;
    const full = path.join(sectionsDir, f);
    const src = fs.readFileSync(full, 'utf8');
    const schema = extractSchema(src);
    sections.push({
      store: path.basename(storeDir),
      root,
      file: f,
      name: (schema && schema.name) || f.replace(/\.liquid$/, '').replace(/[-_]/g, ' '),
      category: null,
      settings: schema ? (schema.settings || []).length : 0,
      blocks: schema ? (schema.blocks || []).length : 0,
      hasPresets: !!(schema && schema.presets && schema.presets.length),
      lines: src.split('\n').length,
      assets: extractAssetRefs(src),
      hasSchema: !!schema,
      empty: src.trim().length === 0,
      hash: contentHash(src),
    });
  }
  return sections;
}

function main() {
  const overrides = loadOverrides();
  const stores = [];
  const sections = [];
  for (const root of ROOTS) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const ingested = ingestStore(root, path.join(root, entry.name));
      if (!ingested) continue;
      const color = storeBrandColor(path.join(root, entry.name));
      stores.push({ name: entry.name, path: path.join(root, entry.name), sectionCount: ingested.length, color, textColor: luminance(color) > 0.6 ? '#191a1c' : '#ffffff' });
      for (const s of ingested) {
        const ov = overrides[`${s.store}/${s.file}`] || {};
        const { category, functional } = classify(s.file, ov);
        s.category = category;
        s.functional = functional;
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

  for (const s of sections) delete s.root;
  const index = { generatedAt: new Date().toISOString(), stores, sections };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(index, null, 2));
  const byCat = {};
  let dupes = 0;
  for (const s of sections) { byCat[s.category] = (byCat[s.category] || 0) + 1; if (s.duplicate) dupes++; }
  console.log(`Ingested ${sections.length} sections from ${stores.length} store(s) across ${ROOTS.length} root(s)`);
  console.log(`Duplicates collapsed: ${dupes} (${groups.size} unique components)`);
  console.log(byCat);
}

if (require.main === module) main();
module.exports = { main, extractSchema };
