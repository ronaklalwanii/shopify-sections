// Theme store roots: every folder here is scanned for <store>/sections.
// Default is the bundled ./stores folder (deployment-friendly); override with
// STORES_ROOTS="dir1,dir2" to scan elsewhere (e.g. local working copies).
const path = require('path');
const fs = require('fs');

const ROOTS = (process.env.STORES_ROOTS || path.resolve(__dirname, '../stores'))
  .split(',')
  .map((s) => path.resolve(__dirname, s))
  .filter((p) => fs.existsSync(p));

function findStore(store) {
  if (typeof store !== 'string' || !store || store === '.' || store === '..' || /[/\\]/.test(store)) return null;
  for (const root of ROOTS) {
    const p = path.join(root, store);
    if (fs.existsSync(path.join(p, 'sections'))) return p;
  }
  return null;
}

module.exports = { ROOTS, findStore };
