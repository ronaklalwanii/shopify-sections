const test = require('node:test');
const assert = require('node:assert/strict');
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
  assert.deepEqual(template.order, ['pack_01_announcement-bar', 'pack_02_collection-list']);
  assert.equal(template.sections[template.order[0]].type, 'azura--announcement-bar');
  const manifest = JSON.parse(strFromU8(files['section-pack.json']));
  assert.equal(manifest.mode, 'theme');
  assert.equal(manifest.sections[0].order, 1);
  assert.ok(files['README.md']);
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
