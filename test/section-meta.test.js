const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { extractSchema, extractSnippetRefs, extractAssetRefs, collectSectionDependencies, parseJsonLoose } = require('../src/section-meta');
const { assertCustomSlug, customFilePath } = require('../src/path-safety');
const { renderSectionSource, renderStoreSection } = require('../src/renderer');
const { normalizePreviewMedia } = require('../src/server');
const { visibleContentIssues, hardIssue } = require('../src/qa');

test('parses Shopify-style loose JSON', () => {
  assert.deepEqual(parseJsonLoose('{"a": 1, "b": [2,],} // trailing comment'), { a: 1, b: [2] });
  assert.deepEqual(extractSchema('{% schema %}{"name":"Demo",}{% endschema %}'), { name: 'Demo' });
  assert.equal(extractSchema('{% schema %}{"name":}{% endschema %}'), null);
});

test('finds snippet and asset dependencies', () => {
  const source = `{% render 'card' %}{% include 'footer' %}{% liquid echo 'x' %}{% render 'card' %}{% endliquid %}{{ 'theme.js' | asset_url }}{{ 'local.css' | stylesheet_tag }}`;
  assert.deepEqual(extractSnippetRefs(source).sort(), ['card', 'footer']);
  assert.deepEqual(extractAssetRefs(source).sort(), ['local.css', 'theme.js']);
});

test('collects transitive dependencies and missing files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'section-library-test-'));
  fs.mkdirSync(path.join(root, 'snippets'), { recursive: true });
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'snippets', 'card.liquid'), `{% render 'icon' %}{{ 'card.css' | asset_url }}`);
  fs.writeFileSync(path.join(root, 'snippets', 'icon.liquid'), `{{ 'icon.js' | asset_url }}`);
  fs.writeFileSync(path.join(root, 'assets', 'card.css'), '');
  fs.writeFileSync(path.join(root, 'assets', 'icon.js'), '');
  const result = collectSectionDependencies(root, `{% render 'card' %}{{ 'missing.js' | asset_url }}`);
  assert.deepEqual(result.snippets, ['card', 'icon']);
  assert.deepEqual(result.assets, ['card.css', 'icon.js', 'missing.js']);
  assert.deepEqual(result.missingSnippets, []);
  assert.deepEqual(result.missingAssets, ['missing.js']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('rejects path traversal and malformed custom slugs', () => {
  assert.throws(() => assertCustomSlug('../package'), /Invalid section slug/);
  assert.throws(() => customFilePath('/tmp/custom', '../package', 'json'), /Invalid section slug/);
  assert.equal(customFilePath('/tmp/custom', 'hero-banner', 'json'), path.resolve('/tmp/custom/hero-banner.json'));
});

test('renders object-form Shopify presets', async () => {
  const source = `{% schema %}{"blocks":[{"type":"item","settings":[{"id":"title","type":"text","default":"Hello from preset"}]}],"presets":[{"blocks":{"one":{"type":"item"}}}]}{% endschema %}<h1>{{ section.blocks[0].settings.title }}</h1>`;
  const result = await renderSectionSource('custom', source, { sectionId: 'preset-test' });
  assert.equal(result.error, null);
  assert.match(result.html, /Hello from preset/);
});

test('uses the supplied demo assets for mocked images and icons', async () => {
  const imageSource = `{% schema %}{"settings":[{"id":"image","type":"image_picker"}]}{% endschema %}{{ section.settings.image | image_url }}`;
  const iconSource = `{% schema %}{"settings":[{"id":"icon","type":"image_picker"}]}{% endschema %}{{ section.settings.icon | image_url }}`;
  const image = await renderSectionSource('custom', imageSource, { sectionId: 'image-test' });
  const icon = await renderSectionSource('custom', iconSource, { sectionId: 'icon-test' });
  assert.equal(image.error, null);
  assert.equal(icon.error, null);
  assert.match(image.html, /\/assets\/demo-image\.jpg/);
  assert.match(icon.html, /\/assets\/star\.svg/);
  const placeholder = await renderSectionSource('custom', "{{ 'icon' | placeholder_svg_tag }}", { sectionId: 'placeholder-test' });
  assert.match(placeholder.html, /\/assets\/star\.svg/);
});

test('handles new-store media patterns and Shopify-style arguments', async () => {
  const source = `{% schema %}{"settings":[{"id":"image","type":"image_picker"},{"id":"icon","type":"image_picker"}]}{% endschema %}
    {{ section.settings.image | image_tag: width: 320, alt: 'Photo', class: 'hero' }}
    {{ section.settings.icon | image_url }}
    {% render 'icon', name: 'cart' %}
    {{ 'photo.jpg' | asset_url | image_url }}
    {{ 'card' | placeholder_svg_tag }}
    {{ 'payment' | payment_type_svg_tag }}
    {{ localization.country | image_url }}
    {{ 'sample' | video_tag }}`;
  const result = await renderSectionSource('custom', source, { sectionId: 'new-store-media' });
  assert.equal(result.error, null);
  assert.match(result.html, /width="320"/);
  assert.match(result.html, /alt="Photo"/);
  assert.match(result.html, /class="hero"/);
  assert.match(result.html, /\/assets\/demo-image\.jpg/);
  assert.match(result.html, /\/assets\/star\.svg/);
  assert.doesNotMatch(result.html, /\[object Object\]/);
});

test('normalizes media fallbacks for future store markup', () => {
  const html = `<img class="hero" src="https://cdn.example.com/photo.jpg"><img class="icon" src="/assets/new/cart.svg"><img srcset="/assets/new/photo.jpg 1x"><video src=""></video><div style="background-image:url(/assets/new/hero.jpg)"></div>`;
  const result = normalizePreviewMedia(html);
  assert.match(result, /hero.*demo-image\.jpg/);
  assert.match(result, /icon.*star\.svg/);
  assert.match(result, /srcset="\/assets\/demo-image\.jpg 1x"/);
  assert.match(result, /poster="\/assets\/demo-image\.jpg"/);
  assert.doesNotMatch(result, /src=""/);
  assert.doesNotMatch(result, /cdn\.example\.com/);
});

test('keeps the Azura collection and announcement sections renderable', async () => {
  const announcement = await renderStoreSection('azura', 'announcement-bar.liquid');
  const collection = await renderStoreSection('azura', 'collection-list.liquid');
  assert.equal(announcement.error, null);
  assert.equal(collection.error, null);
  assert.match(announcement.html, /class="announcement-bar"/);
  assert.match(announcement.html, /\/assets\/star\.svg/);
  assert.match(collection.html, /class="collection-grid/);
  assert.match(collection.html, /\/assets\/demo-image\.jpg/);
});

test('does not call blank rendered output healthy', () => {
  assert.deepEqual(visibleContentIssues('<style>.x{color:red}</style>'), ['no visible content']);
  assert.equal(hardIssue('no visible content'), true);
  assert.equal(hardIssue('needs Shopify block context'), false);
});

test('scales catalog thumbnails and supports two or four columns', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(css, /\.card-thumb iframe\s*\{[^}]*width: 1200px;[^}]*height: 1560px;[^}]*transform-origin: 0 0;/s);
  assert.match(app, /frame\.style\.transform\s*=\s*`scale/);
  assert.match(app, /columns: \[2, 4\]\.includes\(Number\(localStorage\.getItem\('sl-columns'\)\)\) \? Number\(localStorage\.getItem\('sl-columns'\)\) : 2/);
  assert.match(css, /grid-template-columns:\s*repeat\(var\(--columns, 2\), minmax\(0, 1fr\)\)/);
  assert.match(html, /data-columns="2"[^>]*aria-pressed="true"/);
  assert.match(html, /data-columns="4"/);
});

test('protects sandboxed preview assets with a signed preview token', () => {
  const server = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  assert.match(server, /verifyPreviewToken\(req\.query\.sl_preview\)/);
  assert.match(server, /crypto\.createHmac\('sha256', PREVIEW_TOKEN_SECRET\)/);
  assert.match(server, /function tokenizePreviewAssets\(/);
  assert.match(server, /previewAssetToken\(src, previewToken\)/);
});

test('rolls back custom sections when persistence fails', () => {
  const server = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  assert.match(server, /Liquid is required/);
  assert.match(server, /persistCustomSectionRemote\(saved, \{ rollbackCreated: true \}\)/);
  assert.match(server, /removeCustomFiles\(saved\.meta\.slug\)/);
  assert.match(server, /if \(!liquid\.trim\(\)\) continue/);
  assert.match(server, /Contents: read and write permission/);
  assert.match(server, /async function ensureCustomSectionRemote\(/);
  assert.match(server, /refreshCustomSections\(\{ maxAgeMs: 15000 \}\)/);
});
