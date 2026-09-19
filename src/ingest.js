// Ingest: scan shopify-stores/* themes, parse section schemas, classify, write data/index.json
const fs = require('fs');
const path = require('path');

const STORES_ROOT = process.env.STORES_ROOT || path.resolve(__dirname, '../../shopify-stores');
const OUT_FILE = path.resolve(__dirname, '../data/index.json');
const OVERRIDES_FILE = path.resolve(__dirname, '../data/tag-overrides.json');

// Manual category overrides, keyed "store/file" — wins over auto-classification.
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
  // {% stylesheet %} and {% javascript %} legacy blocks map to no asset file (inline).
  return [...refs];
}

function ingestStore(storeDir) {
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
      file: f,
      name: (schema && schema.name) || f.replace(/\.liquid$/, '').replace(/[-_]/g, ' '),
      category: null, // filled by classify
      settings: schema ? (schema.settings || []).length : 0,
      blocks: schema ? (schema.blocks || []).length : 0,
      hasPresets: !!(schema && schema.presets && schema.presets.length),
      lines: src.split('\n').length,
      assets: extractAssetRefs(src),
      hasSchema: !!schema,
      empty: src.trim().length === 0,
    });
  }
  return sections;
}

function main() {
  const overrides = loadOverrides();
  const stores = [];
  const sections = [];
  for (const entry of fs.readdirSync(STORES_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const ingested = ingestStore(path.join(STORES_ROOT, entry.name));
    if (!ingested) continue;
    stores.push({ name: entry.name, path: path.join(STORES_ROOT, entry.name), sectionCount: ingested.length });
    for (const s of ingested) {
      const ov = overrides[`${s.store}/${s.file}`] || {};
      const { category, functional } = classify(s.file, ov);
      s.category = category;
      s.functional = functional;
      s.custom = false;
      sections.push(s);
    }
  }
  const index = { generatedAt: new Date().toISOString(), stores, sections };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(index, null, 2));
  const byCat = {};
  for (const s of sections) byCat[s.category] = (byCat[s.category] || 0) + 1;
  console.log(`Ingested ${sections.length} sections from ${stores.length} store(s)`);
  console.log(byCat);
}

if (require.main === module) main();
module.exports = { main, extractSchema };
