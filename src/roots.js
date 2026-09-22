// Theme store roots: every folder here is scanned for <store>/sections.
const path = require('path');
const fs = require('fs');

const ROOTS = (process.env.STORES_ROOTS || '../../shopify-stores,../../shopify-layouts')
  .split(',')
  .map((s) => path.resolve(__dirname, s))
  .filter((p) => fs.existsSync(p));

function findStore(store) {
  for (const root of ROOTS) {
    const p = path.join(root, store);
    if (fs.existsSync(path.join(p, 'sections'))) return p;
  }
  return null;
}

module.exports = { ROOTS, findStore };
