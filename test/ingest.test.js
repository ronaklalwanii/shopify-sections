const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ingestIndex } = require('../src/ingest');

const ROOT = path.resolve(__dirname, '..');

// Ingesting all 26 stores takes ~6s, so do it once and share the result. Each
// test only reads it, so sharing cannot leak state between them.
let cached = null;
function freshIndex() {
  if (cached) return cached;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-index-'));
  try {
    // qualityReport: null keeps the committed QA report out of the assertions.
    cached = ingestIndex({ outFile: path.join(dir, 'index.json'), roots: [path.join(ROOT, 'stores')], overrides: { qualityReport: null }, quiet: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return cached;
}

function withFreshIndex(run) {
  run(freshIndex());
}

test('marks a section core when the theme layout or a section group renders it', () => {
  withFreshIndex(({ sections }) => {
    // Ground truth: base's layout renders header-group/footer-group/overlay-group.
    const header = sections.find((s) => s.store === 'base' && s.file === 'header.liquid');
    const drawer = sections.find((s) => s.store === 'base' && s.file === 'cart-drawer.liquid');
    assert.equal(header.referenced, true);
    assert.equal(header.core, true);
    assert.equal(drawer.core, true, 'cart-drawer is only reachable through overlay-group');
    // A content section is not core just because a page template uses it.
    const banner = sections.find((s) => s.store === 'base' && s.file === 'collection-banner.liquid');
    assert.equal(banner.core, false, 'collection-banner is collection page content, not chrome');
  });
});

test('derives schema signals used for search and card badges', () => {
  withFreshIndex(({ sections }) => {
    // 16 stores put a real add-to-cart form in main-product; base delegates its
    // buy buttons to app blocks, so it must NOT be reported as having one. That
    // difference is the signal working, not a gap in it.
    const withForm = sections.find((s) => s.store === 'azura' && s.file === 'main-product.liquid');
    assert.equal(withForm.signals.hasProductForm, true);
    assert.ok(withForm.signals.dataObjects.includes('product'));

    const delegated = sections.find((s) => s.store === 'base' && s.file === 'main-product.liquid');
    assert.equal(delegated.signals.hasProductForm, false, 'base main-product uses app blocks for buying');

    const hero = sections.find((s) => s.slug === 'sleek-hero');
    assert.ok(hero, 'expected a sleek-hero section');
    assert.equal(typeof hero.signals.usesBlocks, 'boolean');
    assert.ok(Array.isArray(hero.signals.settingTypes));
    assert.ok(Array.isArray(hero.signals.blockTypes));

    // A form must be found in a minority of sections, or the signal is useless.
    const withProductForm = sections.filter((s) => s.signals.hasProductForm);
    assert.ok(withProductForm.length > 0 && withProductForm.length < sections.length / 10,
      `product-form signal matched ${withProductForm.length}/${sections.length}, which is too broad to be useful`);
  });
});

test('never relabels a confidently classified section', () => {
  withFreshIndex(({ sections }) => {
    // Signals must only rescue sections the filename rules could not place.
    // These all have keyword matches, so their labels must be the keyword ones.
    const expectations = [
      ['base', 'sleek-hero.liquid', 'Hero / Banner'],
      ['base', 'contact.liquid', 'CTA / Newsletter'],
      ['base', 'why-us-commitment.liquid', 'Trust / Social proof'],
      ['base', 'testimonials.liquid', 'Testimonials'],
    ];
    for (const [store, file, expected] of expectations) {
      const section = sections.find((s) => s.store === store && s.file === file);
      assert.ok(section, `${store}/${file} missing from the index`);
      assert.equal(section.category, expected, `${store}/${file} was relabelled by a weak signal`);
    }
  });
});

test('groups same-slug sections across stores and surfaces diverged versions', () => {
  withFreshIndex(({ sections, variants }) => {
    const group = variants['announcement-bar'];
    assert.ok(group, 'announcement-bar appears in many stores, so it must have a group');
    assert.ok(group.stores > 1);
    // Dedupe is by content hash, so a modified version is invisible to it; the
    // variant group is what makes those reachable.
    assert.ok(group.variants.length > 1, 'expected more than one distinct implementation');
    const hashes = new Set(group.variants.map((v) => v.hash));
    assert.equal(hashes.size, group.variants.length, 'each listed variant must be a distinct implementation');

    for (const section of sections.filter((s) => s.variantSlug === 'announcement-bar')) {
      assert.equal(section.diverged, true);
      assert.equal(section.variantCount, group.variants.length);
      // The list must be stored once at the top level, not repeated per member.
      assert.equal(section.variants, undefined, 'variant list must not be duplicated on each section');
    }
  });
});

test('index stays within a size we can hold in memory and ship to the browser', () => {
  withFreshIndex(({ index }) => {
    const bytes = Buffer.byteLength(JSON.stringify(index));
    assert.ok(bytes < 4 * 1024 * 1024, `index is ${(bytes / 1024 / 1024).toFixed(2)} MB, expected under 4 MB`);
  });
});
