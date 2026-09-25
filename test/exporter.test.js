const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { unzipSync, strFromU8 } = require('fflate');
const { buildExport } = require('../src/exporter');

function entries(buffer) {
  return unzipSync(new Uint8Array(buffer));
}

test('builds a ready-to-upload base theme with ordered namespaced sections', () => {
  const result = buildExport({
    mode: 'theme',
    baseStore: 'base',
    name: 'test-pack',
    items: [
      { store: 'azura', file: 'announcement-bar.liquid' },
      { store: 'azura', file: 'collection-list.liquid' },
    ],
  });
  const files = entries(result.buffer);
  assert.ok(files['layout/theme.liquid']);
  assert.ok(files['config/settings_schema.json']);
  assert.ok(files['sections/azura--announcement-bar.liquid']);
  assert.ok(files['sections/azura--collection-list.liquid']);
  assert.equal(files['sections/hero.liquid'], undefined);
  const template = JSON.parse(strFromU8(files['templates/page.section-pack.json']));
  const indexTemplate = JSON.parse(strFromU8(files['templates/index.json']));
  assert.deepEqual(template.order, ['pack_01_announcement-bar', 'pack_02_collection-list']);
  assert.deepEqual(indexTemplate.order, template.order);
  assert.equal(template.sections[template.order[0]].type, 'azura--announcement-bar');
  const manifest = JSON.parse(strFromU8(files['section-pack.json']));
  assert.equal(manifest.mode, 'theme');
  assert.equal(manifest.sections[0].order, 1);
  assert.ok(files['README.md']);
});

test('keeps the base theme functional: header, footer, cart, account, and search files', () => {
  const result = buildExport({
    mode: 'theme',
    baseStore: 'base',
    name: 'functional-pack',
    items: [{ store: 'azura', file: 'announcement-bar.liquid' }],
  });
  const files = entries(result.buffer);
  for (const section of ['header', 'footer', 'main-cart', 'main-product', 'main-collection', 'main-search', 'main-customers-login', 'main-customers-account']) {
    assert.ok(files[`sections/${section}.liquid`], `missing section ${section}.liquid`);
  }
  for (const template of ['cart.json', 'product.json', 'collection.json', 'search.json', '404.json', 'password.json', 'page.json', 'index.json', 'customers/login.json', 'customers/account.json', 'customers/register.json', 'customers/order.json', 'customers/addresses.json']) {
    assert.ok(files[`templates/${template}`], `missing template ${template}`);
  }
  assert.ok(files['layout/theme.liquid']);
  assert.ok(files['config/settings_schema.json']);
  const indexTemplate = JSON.parse(strFromU8(files['templates/index.json']));
  assert.deepEqual(indexTemplate.order, ['pack_01_announcement-bar']);
  const sectionTypes = new Set(Object.values(indexTemplate.sections).map((s) => s.type));
  assert.ok(sectionTypes.has('azura--announcement-bar'));
});

test('treats pre-existing base theme asset gaps as warnings, not export failures', () => {
  const result = buildExport({
    mode: 'theme',
    baseStore: 'base',
    name: 'warning-pack',
    items: [{ store: 'azura', file: 'announcement-bar.liquid' }],
  });
  const files = entries(result.buffer);
  const manifest = JSON.parse(strFromU8(files['section-pack.json']));
  assert.ok(result.warnings.some((w) => w.includes('vendor/qrcode.js')));
  assert.ok(manifest.warnings.some((w) => w.includes('vendor/qrcode.js')));
});

test('rebuilds sections/ as base core plus the pack, dropping unused base content sections', () => {
  const result = buildExport({
    mode: 'theme',
    baseStore: 'base',
    name: 'core-plus-pack',
    items: [{ store: 'azura', file: 'announcement-bar.liquid' }],
  });
  const files = entries(result.buffer);
  const sections = new Set(Object.keys(files).filter((n) => n.startsWith('sections/') && n.endsWith('.liquid')).map((n) => path.basename(n, '.liquid')));
  // Core survives: layout, section groups, and every template still resolve.
  for (const core of ['header', 'footer', 'mega-header', 'announcement-bar', 'cart-drawer', 'search-drawer', 'minimal-footer', 'account-banner', 'main-cart', 'main-product', 'main-collection', 'main-search', 'main-page', 'main-password', 'main-not-found', 'main-gift-card', 'main-customers-login']) {
    assert.ok(sections.has(core), `core section ${core} was dropped`);
  }
  // Base marketing content that only templates/index.json used is gone.
  for (const dropped of ['sleek-hero', 'trust-badge', 'why-buy', 'countdown-banner', 'statement-banner']) {
    assert.equal(sections.has(dropped), false, `${dropped} should have been dropped`);
  }
  // The pack is present, and section groups are kept as JSON.
  assert.ok(sections.has('azura--announcement-bar'));
  for (const group of ['header-group', 'footer-group', 'overlay-group']) {
    assert.ok(files[`sections/${group}.json`], `missing section group ${group}.json`);
  }
  // Snippets, assets, blocks, templates, locales, and config are left as base.
  assert.ok(files['snippets/'] !== undefined || Object.keys(files).some((n) => n.startsWith('snippets/')));
  assert.ok(Object.keys(files).some((n) => n.startsWith('assets/')));
  assert.ok(Object.keys(files).some((n) => n.startsWith('locales/')));
  // Orphaned base snippets/blocks/assets are pruned; the base block files are all
  // unreferenced ai_gen_block_* leftovers, so blocks/ disappears entirely here.
  assert.equal(Object.keys(files).some((n) => n.startsWith('blocks/')), false);
  const manifest = JSON.parse(strFromU8(files['section-pack.json']));
  assert.ok(manifest.baseCoreSections.includes('header'));
  assert.ok(manifest.baseDroppedSections.includes('sleek-hero'));
  assert.ok(manifest.baseDroppedSections.length > 50);
  assert.ok(manifest.unusedFilesDropped.length > 0);
  // The pack's own assets and snippets survive pruning.
  assert.ok(Object.keys(files).some((n) => n.startsWith('assets/azura--')));
});

test('caps the generated template at the Shopify limit of 25 sections per template', () => {
  const files = fs.readdirSync(path.join(__dirname, '..', 'stores', 'base', 'sections'))
    .filter((f) => f.endsWith('.liquid'))
    .slice(0, 26)
    .map((file) => ({ store: 'base', file }));
  assert.equal(files.length, 26);
  const result = buildExport({ mode: 'theme', baseStore: 'base', name: 'too-many', items: files });
  const zipped = entries(result.buffer);
  const indexTemplate = JSON.parse(strFromU8(zipped['templates/index.json']));
  assert.equal(indexTemplate.order.length, 25);
  assert.ok(result.warnings.some((w) => w.includes('at most 25 sections')));
  assert.equal(Object.keys(indexTemplate.sections).length, 25);
});

test('builds a lightweight pack without base theme folders', () => {
  const result = buildExport({
    mode: 'pack',
    baseStore: 'base',
    name: 'light-pack',
    items: [{ store: 'azura', file: 'announcement-bar.liquid' }],
  });
  const files = entries(result.buffer);
  assert.ok(files['sections/azura--announcement-bar.liquid']);
  assert.ok(files['assets/azura--base.css']);
  assert.ok(files['README.md']);
  assert.ok(files['section-pack.json']);
  assert.equal(files['layout/theme.liquid'], undefined);
  assert.equal(files['config/settings_schema.json'], undefined);
  assert.equal(files['templates/page.section-pack.json'], undefined);
});

test('includes modern block dependencies for foreign sections', () => {
  const result = buildExport({
    mode: 'theme',
    baseStore: 'base',
    name: 'block-pack',
    items: [{ store: 'horizon', file: 'header.liquid' }],
  });
  const files = entries(result.buffer);
  assert.ok(Object.keys(files).some((name) => name.startsWith('blocks/horizon--')));
  assert.ok(files['snippets/horizon--header-actions.liquid']);
});

test('rejects invalid selections', () => {
  assert.throws(() => buildExport({ items: [], mode: 'theme' }), /Select at least one/);
  assert.throws(() => buildExport({ items: [{ store: 'azura', file: 'missing.liquid' }], mode: 'theme' }), /Section not found/);
});
