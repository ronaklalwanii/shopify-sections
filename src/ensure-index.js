// Keeps data/index.json in step with the store folders on disk.
//
// The index is a derived cache: stores/ is the source of truth and ingest.js
// rebuilds the index from it. Because the rebuild used to be a manual step, a
// newly dropped-in store folder could sit on disk unindexed and simply never
// appear in the gallery. This compares the index's mtime against the newest
// file under any store root and rebuilds when it is behind.
const fs = require('fs');
const path = require('path');
const { ROOTS } = require('./roots');

const DATA_INDEX = path.resolve(__dirname, '../data/index.json');

// Newest mtime across every file in every store root (~4.5k files, ~25ms).
function newestStoreChange() {
  let newest = 0;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      try { const mtime = fs.statSync(full).mtimeMs; if (mtime > newest) newest = mtime; } catch {}
    }
  };
  for (const root of ROOTS) walk(root);
  return newest;
}

function ensureIndex({ log = () => {} } = {}) {
  if (!ROOTS.length) return { rebuilt: false, reason: 'no-store-roots' };
  const missing = !fs.existsSync(DATA_INDEX);
  if (!missing) {
    let built = 0;
    try { built = fs.statSync(DATA_INDEX).mtimeMs; } catch {}
    if (built >= newestStoreChange()) return { rebuilt: false, reason: null };
  }
  log(missing ? 'data/index.json is missing - ingesting stores' : 'data/index.json is older than stores/ - re-ingesting');
  require('./ingest').main();
  return { rebuilt: true, reason: missing ? 'missing' : 'stale' };
}

module.exports = { ensureIndex, newestStoreChange, DATA_INDEX };
