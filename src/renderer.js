// Liquid renderer: renders Shopify section Liquid to static HTML using liquidjs
// with a mock Shopify data layer (settings, product, cart, translations, ...).
const fs = require('fs');
const path = require('path');
const { Liquid, Tag: LiquidTag } = require('liquidjs');
const { findStore } = require('./roots');
const { extractSchema, parseJsonLoose } = require('./section-meta');

/* ---------------------------------- mocks ---------------------------------- */

const DEMO_IMAGE = '/assets/demo-image.jpg';
const DEMO_ICON = '/assets/star.svg';
const PH = (seed, w, h, kind = 'image') => kind === 'icon' ? DEMO_ICON : DEMO_IMAGE;

function imageMock(seed, alt = 'Sample image', aspect = 1.5, kind = 'image') {
  return { __mock: 'image', seed: String(seed || 'sample'), alt, aspect, kind };
}

// Deterministic seed from arbitrary strings (used for per-setting images).
function seedFor(...parts) {
  return parts.join('-').toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 48) || 'sample';
}

function parseFontHandle(handle) {
  // e.g. "assistant_n4" -> family Assistant, normal 400; "work_sans_i7" -> italic 700
  if (typeof handle !== 'string' || !handle) return null;
  const m = handle.match(/^(.*)_([ni])(\d)$/);
  if (!m) return { family: 'System', weight: 400, style: 'normal', fallback: 'sans-serif' };
  const family = m[1].replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const weight = ({ 3: 300, 4: 400, 5: 500, 6: 600, 7: 700 })[m[3]] || 400;
  return { family, weight, style: m[2] === 'i' ? 'italic' : 'normal', fallback: 'sans-serif' };
}

function looksLikeImage(v) {
  return typeof v === 'string' && /\.(png|jpe?g|gif|webp|avif|svg)(\?|$)/i.test(v);
}

function toImageMock(v, fallbackSeed) {
  if (v == null) return null;
  if (typeof v === 'object' && v.__mock) return v;
  if (looksLikeImage(v)) {
    const base = String(v).split('/').pop().replace(/\.\w+$/, '');
    return imageMock(seedFor('file', base), base);
  }
  return imageMock(seedFor(fallbackSeed || 'img', String(v)), String(v));
}

function variantMock(i = 1) {
  const price = 2900 + i * 500;
  return {
    id: 9000 + i, title: `Option ${i}`, price, final_price: price, compare_at_price: price + 1000,
    available: true, option1: `Option ${i}`, option2: null, option3: null, options: [`Option ${i}`],
    inventory_quantity: 25, inventory_management: 'shopify', weight: 0.5, sku: `SKU-${i}`,
    featured_image: imageMock(seedFor('variant', i)), image: imageMock(seedFor('variant', i)),
    url: '#', barcode: null, selected: i === 1,
  };
}

function productMock(handle = 'sample-product', title = 'Sample Product') {
  const images = [1, 2, 3, 4].map((i) => imageMock(seedFor(handle, 'img', i), title));
  const media = images.map((im) => ({ id: 1, media_type: 'image', image: im, preview_image: im, alt: im.alt, aspect_ratio: im.aspect }));
  return {
    id: 12345, title, handle, type: 'Apparel', vendor: 'Sample Co', available: true,
    price: 3900, price_min: 3900, price_max: 5400, compare_at_price: 4900,
    price_varies: true, available_min: true,
    featured_image: images[0], featured_media: media[0], images, media,
    description: '<p>Built with premium materials and an obsessive attention to detail. This is the sample product used for previews.</p>',
    content: '<p>Built with premium materials and an obsessive attention to detail.</p>',
    metafields: {}, tags: ['new', 'bestseller'], url: '#', published_at: new Date(),
    has_only_default_variant: false, requires_selling_plan: false, selling_plan_groups: [],
    options: ['Size'],
    options_with_values: [{ name: 'Size', position: 1, values: ['Small', 'Medium', 'Large'], selected_value: 'Small' }],
    variants: [variantMock(1), variantMock(2), variantMock(3)],
    selected_or_first_available_variant: variantMock(1),
    first_available_variant: variantMock(1),
    selected_variant: variantMock(1),
    variants_count: 3, images_count: 4, collections: [],
    quantity_price_breaks: [], total_inventory: 75,
  };
}

function collectionMock(handle = 'sample-collection', title = 'Sample Collection', n = 6) {
  const products = Array.from({ length: n }, (_, i) => productMock(`${handle}-p${i + 1}`, `Sample Product ${i + 1}`));
  return {
    id: 555, title, handle, description: `<p>A curated edit of the ${title} line.</p>`,
    products, products_count: products.length, all_products: products, all_products_count: products.length,
    all_types: [], all_tags: [], all_vendors: [], url: '#', published_at: new Date(),
    image: imageMock(seedFor(handle, 'cover'), title), featured_image: imageMock(seedFor(handle, 'cover'), title),
    metafields: {}, default_sort_by: 'best-selling', sort_options: [],
  };
}

function lineItemMock(i = 1) {
  const p = productMock(`cart-item-${i}`, `Cart Item ${i}`);
  return {
    ...p, key: `key${i}`, quantity: i, product_title: p.title, title: p.title,
    variant_title: i === 1 ? null : 'Option 2', image: p.featured_image, image_url: null,
    price: p.price, final_price: p.price, original_price: p.price,
    line_price: p.price * i, original_line_price: p.price * i, final_line_price: p.price * i,
    total_discount: 0, url: '#', properties: {}, discounts: [], discount_allocations: [],
    selling_plan_allocation: null, product: p, variant: p.variants[i - 1], handle: p.handle,
  };
}

function cartMock() {
  const items = [lineItemMock(1), lineItemMock(2)];
  const total = items.reduce((s, it) => s + it.final_line_price, 0);
  return {
    items, item_count: 2, total_price: total, total_discount: 0, original_total_price: total,
    subtotal_price: total, total_weight: 1, currency: 'USD', empty: false, note: null,
    attributes: {}, discounts: [], items_subtotal_price: total,
  };
}

const addressMock = {
  first_name: 'Alex', last_name: 'Morgan', company: '', address1: '12 Sample Street',
  address2: '', city: 'Portland', province: 'OR', province_code: 'OR', country: 'United States',
  country_code: 'US', zip: '97205', phone: '+1 555 0100', name: 'Alex Morgan', id: 1, formatted: '12 Sample Street, Portland OR 97205',
};

const availableCountries = ['United States|US|USD|$', 'Canada|CA|CAD|$', 'United Kingdom|GB|GBP|£', 'Germany|DE|EUR|€', 'Australia|AU|AUD|$']
  .map((s) => { const [name, iso, cur, sym] = s.split('|'); return { name, iso_code: iso, currency: { iso_code: cur, symbol: sym, name: cur }, phone: '+1' }; });

function linkListMock(handle = 'main-menu') {
  const link = (title, children = []) => ({ title, url: '#', links: children, object: { type: 'http' }, active: false, current: false, levels: children.length ? 2 : 1, type: 'link' });
  const menus = {
    'main-menu': () => [
      link('Home'),
      link('Shop All'),
      link('Collections', [link('New Arrivals'), link('Bestsellers'), link('Sale')]),
      link('About'),
      link('Contact'),
    ],
    footer: () => [
      link('Privacy Policy'), link('Terms of Service'), link('Shipping & Returns'), link('Contact'),
    ],
  };
  const build = menus[handle] || menus['main-menu'];
  const items = build();
  return { handle, title: handle.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), links: items, levels: 2, items, empty: false };
}

function articleMock(i = 1) {
  return {
    id: 100 + i, title: `Journal Entry ${i}`, handle: `journal-entry-${i}`, url: '#',
    image: imageMock(seedFor('article', i)), excerpt: '<p>Notes from the studio — process, materials, and what we are making next.</p>',
    content: '<p>Notes from the studio — process, materials, and what we are making next.</p>',
    published_at: new Date(2026, 7, i * 3), author: 'Studio', tags: ['notes'], comments_count: 0, comments: [],
  };
}

function settingDefault(s, ctx) {
  const { id, type, default: def } = s;
  switch (type) {
    case 'text': case 'text_alignment': case 'select': case 'radio': case 'liquid':
      return def != null ? def : (type === 'text' ? 'Sample text' : '');
    case 'textarea': return def != null ? def : 'A short sample description that stands in for real copy in this preview.';
    case 'richtext': return def != null ? def : '<p>Sample <strong>rich text</strong> with a <a href="#">link</a> to stand in for real copy.</p>';
    case 'inline_richtext': return def != null ? def : 'Sample <strong>inline</strong> text';
    case 'image_picker': return imageMock(seedFor(ctx.seedBase, id), id, 1.5, /icon|pictogram|logo/i.test(id) ? 'icon' : 'image');
    case 'url': return def || '#';
    case 'color': return def || ''; // blank by default — sections gate on `!= blank`
    case 'checkbox': return def != null ? !!def : true;
    case 'range': return def != null ? def : (s.min != null ? Math.round(((+s.min) + (+s.max)) / 2) : 0);
    case 'video': case 'video_url':
      return type === 'video' ? { __mock: 'video', seed: seedFor(ctx.seedBase, id) }
        : (def || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    case 'font_picker': return parseFontHandle(def) || { family: 'System', weight: 400, style: 'normal', fallback: 'sans-serif' };
    case 'link_list': return linkListMock(def && typeof def === 'string' ? def : 'main-menu');
    case 'collection': return collectionMock(seedFor(ctx.seedBase, id), 'Sample Collection', 4);
    case 'product': return productMock(seedFor(ctx.seedBase, id));
    case 'blog': return { title: 'Journal', handle: 'journal', articles: [articleMock(1), articleMock(2), articleMock(3)], all_tags: [], url: '#' };
    case 'page': return { title: 'Sample Page', handle: 'sample-page', content: '<p>Sample page content.</p>', url: '#' };
    case 'article': return articleMock(1);
    case 'color_background': case 'color_scheme': case 'color_scheme_group': return def || '';
    case 'html': return def || '<p>Sample embedded content.</p>';
    case 'header': case 'paragraph': return null; // not real settings
    default: return def != null ? def : '';
  }
}

function coercePresetValue(id, value, schemaSetting, ctx) {
  const type = schemaSetting?.type;
  if (type === 'image_picker') return toImageMock(value, seedFor(ctx.seedBase, id));
  if (type === 'font_picker') return parseFontHandle(value) || settingDefault(schemaSetting, ctx);
  if (type === 'link_list') return typeof value === 'string' ? linkListMock(value) : value;
  return value;
}

function blockMock(schemaBlocks, presetBlock, ctx) {
  const def = (schemaBlocks || []).find((b) => b.type === (presetBlock?.type ?? ''));
  const type = presetBlock?.type || def?.type || 'block';
  const settings = {};
  for (const s of def?.settings || []) {
    const d = settingDefault(s, ctx);
    if (d !== null) settings[s.id] = d;
  }
  if (presetBlock?.settings) {
    for (const [k, v] of Object.entries(presetBlock.settings)) {
      const sDef = (def?.settings || []).find((x) => x.id === k);
      settings[k] = coercePresetValue(k, v, sDef, ctx);
    }
  }
  if (presetBlock?.blocks) {
    const nested = presetBlockList(presetBlock);
    return { id: `bl-${seedFor(ctx.seedBase, type)}`, type, settings, shopify_attributes: '', blocks: nested.map((block) => blockMock(schemaBlocks, block, ctx)), block_count: nested.length };
  }
  return { id: `bl-${seedFor(ctx.seedBase, type)}`, type, settings, shopify_attributes: '' };
}

function presetBlockList(preset) {
  if (Array.isArray(preset?.blocks)) return preset.blocks.filter(Boolean);
  if (!preset?.blocks || typeof preset.blocks !== 'object') return [];
  const ordered = Array.isArray(preset.block_order)
    ? preset.block_order.map((id) => preset.blocks[id]).filter(Boolean)
    : Object.values(preset.blocks);
  return ordered.filter(Boolean);
}

function sectionMock(schema, sectionId, theme = {}) {
  const ctx = { seedBase: sectionId };
  const settings = {};
  for (const s of schema?.settings || []) {
    const d = settingDefault(s, ctx);
    if (d !== null) settings[s.id] = d;
  }
  const preset = (schema?.presets || [])[0];
  if (preset?.settings) {
    for (const [k, v] of Object.entries(preset.settings)) {
      const sDef = (schema?.settings || []).find((x) => x.id === k);
      settings[k] = coercePresetValue(k, v, sDef, ctx);
    }
  }
  let blocks = [];
  const configuredBlocks = presetBlockList(preset);
  if (configuredBlocks.length) {
    blocks = configuredBlocks.map((block) => blockMock(schema?.blocks, block, ctx));
  } else if (schema?.blocks?.length) {
    for (const bd of schema.blocks) {
      if (bd.type === '@app') continue;
      const n = Math.min(bd.limit || 3, preset?.block_order?.length || 3, 3);
      for (let i = 0; i < Math.max(1, Math.min(n, 3)); i++) blocks.push(blockMock(schema?.blocks, { type: bd.type }, ctx));
    }
  }
  // Schema defaults may hold editor-time Liquid (e.g. "{{ settings.x.y }}",
  // resolved by Shopify's editor — never by the storefront). Resolve simple
  // global references against the theme; anything else becomes blank instead
  // of leaking raw {{ }} into previews.
  const resolveWalk = (obj) => {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && v.includes('{{')) obj[k] = resolveDynamicDefault(v, theme);
      else if (v && typeof v === 'object' && !v.__mock) resolveWalk(v);
    }
  };
  resolveWalk(settings);
  for (const b of blocks) { resolveWalk(b.settings || {}); for (const nb of b.blocks || []) resolveWalk(nb.settings || {}); }
  return {
    id: sectionId,
    settings,
    blocks,
    block_count: blocks.length,
    shopify_attributes: '',
    location: 'section',
  };
}

function resolveDynamicDefault(value, theme) {
  const m = String(value).trim().match(/^{{\s*settings\.([\w.]+)\s*}}$/);
  if (!m) return '';
  const resolved = resolveSettingsPath(theme || {}, m[1]);
  return (resolved == null || typeof resolved === 'object') ? '' : resolved;
}

/* ------------------------------ color utils -------------------------------- */

function parseCssColor(v) {
  if (v == null || typeof v === 'object') return null;
  const s = String(v).trim();
  let m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (m) {
    let hex = m[1];
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
    const a = hex.length === 8 ? Math.round(parseInt(hex.slice(6, 8), 16) / 255 * 100) / 100 : 1;
    return { r, g, b, a };
  }
  m = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] == null ? 1 : +m[4] };
  return null;
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h, s, l) {
  if (s === 0) { const v = Math.round(l * 255); return { r: v, g: v, b: v }; }
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  };
}

function fmtColor({ r, g, b }, a = 1) {
  if (a == null || Number(a) >= 1) {
    return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  }
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Number(a)})`;
}

// Static ESM detection: only static import/export statements force module
// semantics — dynamic import() is legal in classic scripts too.
function isEsmJs(src) {
  return /^\s*import(?!\s*\()|^[^'"]*\bexport\s/m.test(String(src || ''));
}

const assetContentCache = new Map(); // storePath/file -> contents (or null)
function readAsset(storePath, file) {
  const key = `${storePath}::${file}`;
  if (assetContentCache.has(key)) return assetContentCache.get(key);
  let out = null;
  try {
    const assetsRoot = path.join(storePath, 'assets');
    const full = path.resolve(assetsRoot, file);
    const relative = path.relative(assetsRoot, full);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) out = fs.readFileSync(full, 'utf8');
  } catch { out = null; }
  assetContentCache.set(key, out);
  return out;
}

/* --------------------------------- filters --------------------------------- */

function money(v, format) {
  if (v == null || isNaN(Number(v))) return '';
  const amount = (Number(v) / 100).toFixed(2);
  const fmt = format || '${{amount}}';
  return fmt.replace('{{amount}}', amount).replace('{{amount_no_decimals}}', (Number(v) / 100).toFixed(0))
    .replace('{{amount_with_comma_separator}}', amount.replace('.', ',')).replace('{{amount_no_decimals_with_comma_separator}}', (Number(v) / 100).toFixed(0).replace('.', ','));
}

function imageInputInfo(input) {
  // Returns {seed,w,h,alt,src} for mock image objects, legacy image URLs, or placeholder URLs.
  if (input && input.__mock === 'image') {
    const h = Math.round(1000 / (input.aspect || 1.5));
    return { seed: input.seed, w: 1000, h, alt: input.alt || '', src: null, kind: input.kind || 'image' };
  }
  if (typeof input === 'string') {
    const pm = input.match(/^https:\/\/picsum\.photos\/seed\/([^/]+)\/(\d+)\/(\d+)$/);
    if (pm) return { seed: decodeURIComponent(pm[1]), w: +pm[2], h: +pm[3], alt: '', src: null };
    const m = input.match(/^\/ph\/([^/]+)\/(\d+)x(\d+)\.svg$/);
    if (m) return { seed: m[1], w: +m[2], h: +m[3], alt: '', src: null };
    if (/\.(png|jpe?g|gif|webp|svg)$/i.test(input)) return { seed: input, w: 1000, h: 667, alt: '', src: input };
  }
  if (input && typeof input === 'object' && (input.src || input.preview_image)) return imageInputInfo(input.src || input.preview_image);
  return null;
}

// Theme typography: map the store's font families to Google Fonts so local
// previews render with the real typefaces instead of system fonts.
function googleFontsLink(engine) {
  const fams = new Set();
  for (const v of Object.values(engine.theme || {})) {
    if (v && typeof v === 'object' && v.family && v.fallback) fams.add(v.family);
  }
  if (!fams.size) return '';
  const spec = [...fams].map((f) => `family=${f.replace(/ /g, '+')}:wght@300;400;500;600;700`).join('&');
  return `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${spec}&display=swap">`;
}

function buildFilters(storeName) {
  const assetUrl = (file) => `/assets/${storeName}/${file}`;
  return {
    image_url(input, opts = {}) {
      const info = imageInputInfo(input);
      if (!info) return input;
      if (info.src) return /^https?:\/\//.test(info.src) || info.src.startsWith('/') ? info.src : `/assets/${storeName}/${info.src}`;
      const w = Math.min(+opts.width || info.w || 1000, 2400);
      const h = Math.round(w * (info.h / info.w));
      return PH(info.seed, w, h, info.kind);
    },
    img_url(input, size = '1000x') {
      const info = imageInputInfo(input);
      if (!info) return input;
      if (info.src) return /^https?:\/\//.test(info.src) || info.src.startsWith('/') ? info.src : `/assets/${storeName}/${info.src}`;
      const m = String(size).match(/^(\d*)x?(\d*)/);
      const w = +m[1] || info.w, h = +m[2] || Math.round(w / (info.w / info.h));
      return PH(info.seed, w, h, info.kind);
    },
    image_tag(input, ...rest) {
      // Merge hash args defensively; liquidjs can degrade complex hashes to positional args.
      const opts = Object.assign({}, ...rest.filter((r) => r && typeof r === 'object' && !Array.isArray(r)));
      const info = imageInputInfo(input);
      if (!info) return '';
      const src = info.src || (() => { const w = Math.min(+(opts.width || info.w || 1000), 2400); return PH(info.seed, w, Math.round(w * (info.h / info.w)), info.kind); })();
      const alt = opts.alt != null ? opts.alt : (info.alt || 'Sample image');
      const excluded = new Set(['width', 'height', 'widths', 'sizes', 'alt', 'loading', 'class']);
      const attrs = Object.entries(opts)
        .filter(([k, v]) => v != null && !/^\d+$/.test(k) && !excluded.has(k) && typeof v !== 'object')
        .map(([k, v]) => `${k}="${String(v).replace(/"/g, '&quot;')}"`).join(' ');
      const w = opts.width || info.w || 1000;
      return `<img src="${src}" alt="${String(alt).replace(/"/g, '&quot;')}" width="${w}" height="${opts.height || Math.round(w * (info.h / info.w))}" loading="${opts.loading || 'lazy'}"${opts.class ? ` class="${opts.class}"` : ''}${opts.sizes ? ` sizes="${opts.sizes}"` : ''}${attrs ? ' ' + attrs : ''}>`;
    },
    placeholder_svg_tag(name = 'image', cls = '') {
      const label = String(name).replace(/[-_]/g, ' ');
      const src = /icon|pictogram|logo/i.test(label) ? DEMO_ICON : DEMO_IMAGE;
      return `<img class="placeholder-svg ${cls}" src="${src}" alt="${label.replace(/"/g, '&quot;')}" loading="lazy">`;
    },
    money, money_with_currency: (v, f) => money(v, f || '${{amount}} USD'),
    money_without_currency: (v) => (Number(v) / 100).toFixed(2),
    money_without_trailing_zeros: (v) => String(Number((Number(v) / 100).toFixed(2)).toString()),
    asset_url: assetUrl, shopify_asset_url: (f) => assetUrl(f),
    stylesheet_tag: (href, opts = {}) => `<link rel="stylesheet" href="${assetUrl(href)}"${opts.media ? ` media="${opts.media}"` : ''}>`,
    script_tag: (src, opts = {}) => {
      // ESM bundles must load as modules — a classic <script> would throw
      // "Cannot use import statement outside a module" in the preview.
      let esm = false;
      try {
        const sp = findStore(storeName);
        if (sp) { const c = readAsset(sp, src); esm = c != null && isEsmJs(c); }
      } catch { esm = false; }
      const type = esm ? ' type="module"' : '';
      return `<script src="${assetUrl(src)}"${type}${opts.async ? ' async' : ''}${opts.defer ? ' defer' : ''}></script>`;
    },
    inline_asset_content: (file) => {
      try {
        const sp = findStore(storeName);
        if (!sp) return '';
        return readAsset(sp, file) || '';
      } catch { return ''; }
    },
    preload_tag: (file, opts = {}) => `<link rel="preload" href="${assetUrl(file)}" as="${opts.as || 'style'}">`,
    font_face(font, opts = {}) {
      if (!font || !font.family) return '';
      const w = font.weight || 400, st = font.style || 'normal';
      return `@font-face{font-family:'${font.family}';font-weight:${w};font-style:${st};font-display:swap;src:local('${font.family}')}`;
    },
    font_modify(font, key, val) {
      if (!font) return null;
      const f = { ...font };
      if (key === 'weight') f.weight = { bold: 700, normal: 400, 'bolditalic': 700, black: 900, lighter: 300 }[val] ?? parseInt(val) ?? f.weight;
      if (key === 'style') f.style = val;
      return f;
    },
    hex_to_rgba(hex, a = 1) {
      const c = parseCssColor(hex);
      if (!c) return hex;
      return `rgba(${c.r},${c.g},${c.b},${a})`;
    },
    color_darken(color, amount = 10) {
      const c = parseCssColor(color);
      if (!c) return color;
      const [h, s, l] = rgbToHsl(c.r, c.g, c.b);
      return fmtColor(hslToRgb(h, s, Math.max(0, l - Number(amount) / 100)), c.a);
    },
    color_lighten(color, amount = 10) {
      const c = parseCssColor(color);
      if (!c) return color;
      const [h, s, l] = rgbToHsl(c.r, c.g, c.b);
      return fmtColor(hslToRgb(h, s, Math.min(1, l + Number(amount) / 100)), c.a);
    },
    color_modify(color, prop, val) {
      const c = parseCssColor(color);
      if (!c) return color;
      const p = String(prop || '').toLowerCase();
      if (p === 'alpha') return fmtColor(c, Number(val));
      const ch = { red: 'r', green: 'g', blue: 'b' }[p];
      if (ch) { c[ch] = Math.max(0, Math.min(255, Math.round(Number(val)))); return fmtColor(c, c.a); }
      return color;
    },
    color_mix(c1, c2, weight = 50) {
      const a = parseCssColor(c1), b = parseCssColor(c2);
      if (!a || !b) return c1;
      const w = Math.max(0, Math.min(100, Number(weight))) / 100;
      return fmtColor({
        r: Math.round(a.r * w + b.r * (1 - w)),
        g: Math.round(a.g * w + b.g * (1 - w)),
        b: Math.round(a.b * w + b.b * (1 - w)),
      }, 1);
    },
    color_brightness(color) {
      const c = parseCssColor(color);
      if (!c) return 0;
      return Math.round(c.r * 0.299 + c.g * 0.587 + c.b * 0.114);
    },
    color_extract(color, prop) {
      const c = parseCssColor(color);
      if (!c) return '';
      const p = String(prop || '').toLowerCase();
      if (p === 'alpha') return c.a;
      if (p === 'red') return c.r;
      if (p === 'green') return c.g;
      if (p === 'blue') return c.b;
      if (p === 'lightness') return Math.round(rgbToHsl(c.r, c.g, c.b)[2] * 100);
      return '';
    },
    color_to_rgb(color) {
      const c = parseCssColor(color);
      if (!c) return color;
      return `${c.r}, ${c.g}, ${c.b}`;
    },
    handle: (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    handleize: (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    format_address(addr) {
      if (!addr) return '';
      return [addr.address1, addr.address2, [addr.city, addr.province, addr.zip].filter(Boolean).join(' '), addr.country].filter(Boolean).join(', ');
    },
    video_tag(video, opts = {}) {
      const seed = video?.seed || 'video';
      const w = opts.image_size ? parseInt(opts.image_size) || 1280 : 1280;
      return `<video ${opts.controls ? 'controls ' : ''}muted playsinline loop poster="${PH(seed, w, Math.round(w * 0.5625))}"></video>`;
    },
    default_errors: () => '',
    time_tag: (date, opts = {}) => `<time datetime="${date instanceof Date ? date.toISOString() : date}">${opts.format ? '' : date}</time>`,
    translated_date: (d) => (d instanceof Date ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : String(d ?? '')),
  };
}

/* ----------------------------------- tags ----------------------------------- */

const FORM_ACTIONS = {
  product: '/cart/add', customer_login: '/account/login', customer_register: '/account/register',
  recover_customer_password: '/account/recover', reset_customer_password: '/account/reset',
  activate_customer_password: '/account/activate', guest_login: '/account/login',
  contact: '/contact#contact_form', new_comment: '#', currency: '#', localization: '#', store_availability: '#',
};

// split "'product', product, id: x" at top-level commas
function splitArgs(s) {
  const out = []; let depth = 0, cur = '', q = null;
  for (const ch of s) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function makeTags(liquid) {
  // Collect raw body source until end<name>, synchronously (streams drain at parse time).
  const collectBody = (name, token, remainTokens) => {
    const raw = [];
    const stream = liquid.parser.parseStream(remainTokens)
      .on('token', (tok) => { if (tok.name === `end${name}`) stream.stop(); else raw.push(tok.getText()); })
      .on('end', () => { throw new Error(`{% ${name} %} not closed`); });
    stream.start();
    return { args: token.args, source: raw.join('') };
  };

  const blockTag = (name) => ({
    parse(token, remainTokens) {
      const { args, source } = collectBody(name, token, remainTokens);
      this.args = args;
      this.templates = liquid.parse(source);
    },
    *render(ctx, emitter) {
      let attrs = '';
      const scope = { form: { errors: {}, posted_successfully: false, id: 'form' } };
      try {
        const vals = [];
        for (const p of splitArgs(this.args || '')) vals.push(yield liquid.evalValue(p, ctx));
        const type = String(vals[0] ?? '').replace(/['"]/g, '');
        if (name === 'form') {
          const action = FORM_ACTIONS[type] || '#';
          attrs = ` action="${action}" method="post"${type === 'product' ? ' enctype="multipart/form-data"' : ''} id="form-${type}"`;
          if (type === 'product' && vals[1]) scope.form.id = `product_form_${vals[1].id ?? ''}`;
          if (type === 'contact') scope.form.id = 'contact_form';
        } else if (name === 'paginate') {
          const coll = vals[0] || {};
          scope.paginate = {
            items: coll.products_count ?? coll.all_products_count ?? 12, page_size: vals[1] ?? 12,
            current_page: 1, pages: 3, previous: null,
            next: { url: '#', title: 'Next' }, parts: [{ url: '#', page: 1, is_link: false, title: '1' }],
          };
        }
      } catch { /* render with defaults */ }
      ctx.push(scope);
      if (name === 'form') emitter.write(`<form${attrs}>`);
      yield* liquid.renderer.renderTemplates(this.templates, ctx, emitter);
      ctx.pop();
      if (name === 'form') emitter.write('</form>');
    },
  });

  // Passthrough/absorb tags: schema (parsed separately), legacy stylesheet/javascript.
  const absorbTag = (name) => ({
    parse(token, remainTokens) { collectBody(name, token, remainTokens); },
    render() {},
  });

  const styleTag = {
    parse(token, remainTokens) {
      const { source } = collectBody('style', token, remainTokens);
      this.templates = liquid.parse(source);
    },
    *render(ctx, emitter) {
      emitter.write('<style>');
      yield* this.liquid.renderer.renderTemplates(this.templates, ctx, emitter);
      emitter.write('</style>');
    },
  };

  // Single tags without bodies.
  const noOp = { parse() {}, render() {} };

  return {
    style: styleTag,
    form: blockTag('form'),
    paginate: blockTag('paginate'),
    schema: absorbTag('schema'),
    stylesheet: absorbTag('stylesheet'),
    javascript: absorbTag('javascript'),
    layout: noOp,        // {% layout none %}
    section: noOp,       // {% section 'name' %} — templates only
    content_for: noOp,   // Horizon theme blocks — not renderable in isolation
    doc: absorbTag('doc'), // LiquidDoc — documentation comments
    endcomment: noOp,    // tolerate orphan {% endcomment %} (Shopify is lenient, liquidjs is not)
  };
}

/* --------------------------------- engine ---------------------------------- */

function themeSettings(storePath) {
  const settings = {};
  try {
    const schema = parseJsonLoose(fs.readFileSync(path.join(storePath, 'config/settings_schema.json'), 'utf8')) || [];
    for (const group of schema) {
      if (!group || !Array.isArray(group.settings)) continue;
      for (const s of group.settings) {
        if (!s || !s.id) continue;
        if (s.type === 'font_picker') settings[s.id] = parseFontHandle(s.default);
        else if (s.type === 'image_picker') settings[s.id] = null;
        else settings[s.id] = s.default != null ? s.default : null;
      }
    }
  } catch {}
  try {
    const data = parseJsonLoose(fs.readFileSync(path.join(storePath, 'config/settings_data.json'), 'utf8')) || {};
    const cur = data.current || {};
    for (const [k, v] of Object.entries(cur)) {
      if (v == null) continue;
      if (looksLikeImage(v)) settings[k] = toImageMock(v, k);
      else if (typeof v === 'string' && /^[\w-]+_n\d$|^[\w-]+_i\d$/.test(v)) settings[k] = parseFontHandle(v) || v;
      else settings[k] = v;
    }
  } catch {}
  return settings;
}

function loadLocale(storePath) {
  for (const f of ['en.default.json', 'en.json']) {
    try { return JSON.parse(fs.readFileSync(path.join(storePath, 'locales', f), 'utf8')); } catch {}
  }
  return {};
}

function tFilter(locale) {
  return function t(key, ...rest) {
    const opts = rest.find((r) => r && typeof r === 'object' && !Array.isArray(r) && !(r instanceof Liquid.Scope)) || {};
    let node = locale;
    for (const part of String(key).split('.')) {
      node = node && typeof node === 'object' ? node[part] : undefined;
    }
    if (node && typeof node === 'object') {
      if (opts.count != null && node[opts.count === 1 ? 'one' : 'other'] != null) node = node[opts.count === 1 ? 'one' : 'other'];
      else node = Object.values(node)[0];
    }
    if (typeof node !== 'string') {
      const last = String(key).split('.').pop();
      return last.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    }
    let out = node;
    for (const [k, v] of Object.entries(opts)) {
      out = out.split(`{{${k}}}`).join(v).split(`{{ ${k} }}`).join(v);
    }
    // Fill placeholders the caller didn't pass so previews don't leak {{ ... }}.
    out = out.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, name) => {
      const n = name.split('.').pop().toLowerCase();
      if (/^(count|index|quantity|page|total|number|forloop)$/.test(n)) return '2';
      if (/^(price|amount|total_price)$/.test(n)) return '$49.00';
      if (/^(name|title|first_name|product|customer|email)$/.test(n)) return 'Sample';
      return 'Sample';
    });
    return out;
  };
}

const engines = new Map(); // storePath -> {liquid, context factory}

function getEngine(storeName, storePath) {
  if (engines.has(storePath)) return engines.get(storePath);
  const locale = loadLocale(storePath);
  const liquid = new Liquid({
    root: [path.join(storePath, 'snippets'), path.join(storePath, 'sections')],
    extname: '.liquid',
    strictVariables: false,
    strictFilters: false,
    jsTruthy: true,
    cache: true,
    greedySchemas: false,
  });
  for (const [name, Tag] of Object.entries(makeTags(liquid))) liquid.registerTag(name, Tag);
  for (const [name, fn] of Object.entries(buildFilters(storeName))) liquid.registerFilter(name, fn);
  liquid.registerFilter('t', tFilter(locale));
  liquid.registerFilter('translate', tFilter(locale));

  const theme = themeSettings(storePath);
  const engine = { liquid, storeName, storePath, theme };
  engines.set(storePath, engine);
  return engine;
}

function baseGlobals(engine, opts = {}) {
  const storeName = engine.storeName;
  const prettyStore = storeName.charAt(0).toUpperCase() + storeName.slice(1);
  return {
    settings: engine.theme,
    shop: {
      name: prettyStore, url: '#', domain: `${storeName}.example.com`, currency: 'USD', locale: 'en',
      money_format: '${{amount}}', money_with_currency_format: '${{amount}} USD',
      email: `hello@${storeName}.example.com`, description: `${prettyStore} — a sample store for previews.`,
      brands: [], policies: [], metafields: {},
    },
    routes: {
      root_url: '/', root: '/', cart_url: '/cart', cart_add_url: '/cart/add', cart_change_url: '/cart/change',
      search_url: '/search', predictive_search_url: '/search/suggest',
      account_url: '/account', account_login_url: '/account/login', account_register_url: '/account/register',
      account_recover_url: '/account/recover', account_addresses_url: '/account/addresses',
      collections_url: '/collections', all_products_collection_url: '/collections/all',
    },
    request: { origin: 'http://localhost', page_type: opts.pageType || 'index', path: '/', locale: '', host: 'localhost', design: { mode: 'development' }, page: {} },
    template: { name: 'index', suffix: null, directory: '' },
    product: productMock(),
    collection: collectionMock('sample-collection', 'Sample Collection', 8),
    collections: new Proxy({ all: collectionMock('all', 'All products', 8), featured: collectionMock('featured', 'Featured', 6), frontpage: collectionMock('frontpage', 'Frontpage', 6) }, {
      get(t, k) { return t[k] || collectionMock(String(k), String(k).replace(/[-_]/g, ' ')); },
    }),
    all_products: new Proxy({}, { get(t, k) { return t[k] || productMock(String(k), 'Sample Product'); } }),
    cart: cartMock(),
    customer: opts.customer ? {
      first_name: 'Alex', last_name: 'Morgan', name: 'Alex Morgan', email: 'alex@example.com',
      addresses: [addressMock], default_address: addressMock, orders: [], orders_count: 2,
      total_spent: 12300, accepts_marketing: true, tags: [], phone: null, new_address: addressMock,
    } : null,
    linklists: new Proxy({ 'main-menu': linkListMock('main-menu'), footer: linkListMock('footer'), 'footer-menu': linkListMock('footer') }, {
      get(t, k) { return t[k] || linkListMock(String(k)); },
    }),
    blogs: new Proxy({ news: { title: 'Journal', handle: 'news', articles: [articleMock(1), articleMock(2), articleMock(3)], all_tags: [], url: '#' } }, {
      get(t, k) { return t[k] || { title: 'Journal', handle: String(k), articles: [articleMock(1), articleMock(2), articleMock(3)], all_tags: [], url: '#' }; },
    }),
    article: articleMock(1),
    blog: { title: 'Journal', handle: 'news', articles: [articleMock(1), articleMock(2), articleMock(3)], all_tags: [], url: '#' },
    page: { title: 'Sample Page', handle: 'sample-page', content: '<p>Sample page content for this preview.</p>', url: '#', author: 'Studio', published_at: new Date() },
    page_title: 'Sample Page',
    page_description: 'A sample page description for previews.',
    search: { terms: 'sample', performed: true, results: [productMock(), productMock('p2', 'Another Product')], results_count: 2, result_types: [] },
    recommendations: { performed: true, products_count: 4, products: [1, 2, 3, 4].map((i) => productMock(`rec-${i}`, `You May Also Like ${i}`)), url: '#', intent: 'related' },
    localization: {
      country: availableCountries[0], available_countries: availableCountries, language: { iso_code: 'en', name: 'English', endonym_name: 'English' },
      available_languages: [{ iso_code: 'en', name: 'English', endonym_name: 'English' }],
    },
    theme: { name: 'base', id: 1, schema_version: '2.0', author: 'Studio' },
    content_for_header: '',
    shopify_features: {},
    form: { errors: {}, posted_successfully: false, id: 'form', author: '', email: '', body: '' },
  };
}

/* -------------------------------- rendering --------------------------------- */

function extractTagBlocks(src, tag) {
  const out = [];
  const re = new RegExp(`{%\\s*${tag}\\s*%}([\\s\\S]*?){%\\s*end${tag}\\s*%}`, 'g');
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  return out.join('\n');
}

async function renderLiquid(engine, source, { sectionId = 'preview', extraGlobals = {}, customer = false } = {}) {
  // Strip schema before the engine: schema JSON can contain `{{ ... }}` (visible_if)
  // that defeats the tokenizer; we parse it separately for defaults.
  const schema = extractSchema(source);
  source = source.replace(/{%-?\s*schema\s*-?%}[\s\S]*?{%-?\s*endschema\s*-?%}/gi, '');
  const sec = sectionMock(schema, sectionId, engine.theme);
  const scope = { ...baseGlobals(engine, { customer }), ...extraGlobals, section: sec, block: (sec.blocks || [])[0] };
  let out = await engine.liquid.parseAndRender(source, scope);
  out = unescapeMediaTags(out);
  return out;
}

// Shopify binds a trailing `| escape` inside filter hashes to the hash value;
// liquidjs binds it to the whole chain, double-escaping HTML-producing filters
// (image_tag, placeholder_svg_tag, ...). Undo that for media tags only.
function unescapeMediaTags(html) {
  return html.replace(/&lt;(img|svg|video|source|iframe|picture)\b((?:[^&]|&(?!gt;))*)&gt;/g, (_, tag, attrs) => {
    const clean = attrs
      .replace(/&(quot|#34);/g, '"')
      .replace(/&(apos|#39);/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    return `<${tag}${clean}>`;
  });
}

async function renderSectionSource(storeName, source, opts = {}) {
  const storePath = storeName === 'custom'
    ? null
    : findStore(storeName);
  const engine = getEngine(storeName, storePath || path.resolve(__dirname, '../custom-sections'));
  try {
    const html = await renderLiquid(engine, source, opts);
    return { html, error: null };
  } catch (e) {
    return { html: '', error: (e && e.message) || String(e) };
  }
}

async function renderStoreSection(storeName, file, opts = {}) {
  const storePath = findStore(storeName);
  const full = path.join(storePath, 'sections', file);
  const src = fs.readFileSync(full, 'utf8');
  const js = extractTagBlocks(src, 'javascript');
  const legacyCss = extractTagBlocks(src, 'stylesheet');
  const res = await renderSectionSource(storeName, src, opts);
  return { ...res, js, legacyCss };
}

// Render a theme snippet (e.g. css-variables) with the store's real settings —
// used by previews to reproduce the layout's <head> (design tokens, @font-face).
async function renderSnippet(storeName, snippetName) {
  const storePath = findStore(storeName);
  if (!storePath) return '';
  const p = path.join(storePath, 'snippets', `${snippetName}.liquid`);
  if (!fs.existsSync(p)) return '';
  const engine = getEngine(storeName, storePath);
  try {
    const src = fs.readFileSync(p, 'utf8');
    return await engine.liquid.parseAndRender(src, baseGlobals(engine, {}));
  } catch { return ''; }
}

// Some themes define their :root design tokens in inline {% style %} blocks
// inside layout/theme.liquid rather than a snippet — render those too.
async function renderLayoutTokens(storeName) {
  const storePath = findStore(storeName);
  if (!storePath) return '';
  let layout = '';
  try { layout = fs.readFileSync(path.join(storePath, 'layout', 'theme.liquid'), 'utf8'); } catch { return ''; }
  const blocks = [];
  for (const m of layout.matchAll(/{%-?\s*style\s*-?%}([\s\S]*?){%-?\s*endstyle\s*-?%}/g)) blocks.push(m[1]);
  for (const m of layout.matchAll(/<style>([\s\S]*?)<\/style>/g)) blocks.push(m[1]);
  const source = blocks.join('\n').trim();
  if (!source) return '';
  const engine = getEngine(storeName, storePath);
  try { return balanceBraces(await engine.liquid.parseAndRender(source, baseGlobals(engine, {}))); } catch { return ''; }
}

// Balance unclosed rules in extracted token CSS (some layouts never close
// `body {` before {% endstyle %}). Contained to the token <style> element,
// but an unbalanced block would still drop the rules inside it.
function balanceBraces(css) {
  const stripped = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/g, '""');
  let depth = 0;
  for (const ch of stripped) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  return depth > 0 ? `${css}\n${'}'.repeat(depth)}` : css;
}

function resolveSettingsPath(theme, dotted) {
  let node = theme;
  for (const part of String(dotted).split('.')) {
    if (node == null || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return node;
}

// Neutral preview defaults for well-known token families — only used when the
// store has no value configured, so var() references never collapse to nothing.
function neutralTokenDefault(varName) {
  const n = String(varName).toLowerCase();
  if (/accent-label|on-accent/.test(n)) return '#ffffff';
  if (/accent|link|button/.test(n)) return '#2f6f4f';
  if (/border|outline|divider/.test(n)) return '#e2ded6';
  if (/muted|subtle|faded/.test(n)) return 'rgba(26,26,26,.62)';
  if (/secondary/.test(n)) return '#f4f2ed';
  if (/background|surface|card-bg|canvas|base/.test(n)) return '#ffffff';
  if (/foreground|text|heading|color|ink/.test(n)) return '#1a1a1a';
  return null;
}

// Design-token fallback: layout {% style %} blocks often declare --color-*
// custom properties OUTSIDE any rule (dropped as invalid CSS at render time),
// so theme CSS var() references would resolve to nothing in previews. Re-emit
// every `--var: {{ settings.* }};` pair from the layout source as a valid
// :root block, evaluated with the store's real settings. Emitted BEFORE the
// theme's own tokens, so genuine theme values always win the cascade.
async function layoutTokensFallback(storeName) {
  const storePath = findStore(storeName);
  if (!storePath) return '';
  const engine = getEngine(storeName, storePath);
  let layout = '';
  try { layout = fs.readFileSync(path.join(storePath, 'layout', 'theme.liquid'), 'utf8'); } catch { return ''; }
  const seen = new Map(); // varName -> { expr, unit }
  const re = /(--[\w-]+)\s*:\s*({{\s*settings\.[\w.]+[\s\S]*?}})\s*([a-z%]*)\s*;/g;
  let m;
  while ((m = re.exec(layout))) {
    if (!seen.has(m[1])) seen.set(m[1], { expr: m[2], unit: m[3] || '' });
  }
  if (!seen.size) return '';
  const out = [];
  for (const [varName, { expr, unit }] of seen) {
    const pathMatch = expr.match(/settings\.([\w.]+)/);
    const raw = pathMatch ? resolveSettingsPath(engine.theme, pathMatch[1]) : undefined;
    if (raw != null && typeof raw === 'object') continue; // fonts, images, palettes — not plain tokens
    let value = '';
    if (raw != null && raw !== '') {
      try { value = String(await engine.liquid.parseAndRender(expr, { settings: engine.theme })).trim(); } catch { value = ''; }
    }
    if (!value) value = neutralTokenDefault(varName) || '';
    if (value) out.push(`${varName}: ${value}${unit};`);
  }
  return out.length ? `:root{\n${out.join('\n')}\n}` : '';
}

module.exports = { renderSectionSource, renderStoreSection, getEngine, imageMock, renderSnippet, renderLayoutTokens, layoutTokensFallback, findStore, parseJsonLoose, googleFontsLink, isEsmJs };
