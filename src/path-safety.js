const path = require('path');

const CUSTOM_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

function assertCustomSlug(slug) {
  if (typeof slug !== 'string' || !CUSTOM_SLUG.test(slug)) throw new Error('Invalid section slug');
  return slug;
}

function customFilePath(root, slug, extension) {
  assertCustomSlug(slug);
  const base = path.resolve(root);
  const full = path.resolve(base, `${slug}.${extension}`);
  if (path.dirname(full) !== base) throw new Error('Invalid section path');
  return full;
}

module.exports = { CUSTOM_SLUG, assertCustomSlug, customFilePath };
