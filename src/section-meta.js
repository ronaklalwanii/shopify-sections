const fs = require('fs');
const path = require('path');
const { toLiquidHtmlAST } = require('@shopify/liquid-html-parser');

function parseJsonLoose(text) {
  try { return JSON.parse(text); } catch {}
  let out = '', inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i], next = text[i + 1];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; out += char; continue; }
    if (char === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (char === '/' && next === '/') {
      const end = text.indexOf('\n', i + 2);
      i = end === -1 ? text.length : end - 1;
      continue;
    }
    out += char;
  }
  try { return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')); } catch { return null; }
}

function extractSchema(source) {
  const match = String(source || '').match(/{%-?\s*schema\s*-?%}([\s\S]*?){%-?\s*endschema\s*-?%}/i);
  return match ? parseJsonLoose(match[1]) : null;
}

function scanRenderEdits(source) {
  let ast;
  try { ast = toLiquidHtmlAST(String(source || '')); } catch { return null; }
  const edits = [];
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'LiquidTag' && (node.name === 'render' || node.name === 'include')) {
      const raw = source.slice(node.position.start, node.position.end);
      const match = raw.match(/\b(?:render|include)\s+(['"])([\w-]+)\1/);
      if (match) {
        const nameStart = node.position.start + match.index + match[0].indexOf(match[2]);
        edits.push({ start: nameStart, end: nameStart + match[2].length, name: match[2] });
      }
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object' && value.type) walk(value);
    }
  })(ast);
  return edits;
}

function extractSnippetRefs(source) {
  const edits = scanRenderEdits(source);
  if (edits) return [...new Set(edits.map((edit) => edit.name))];
  const names = [];
  const tagged = /{%-?\s*(?:render|include)\s+(['"])([\w-]+)\1/g;
  const bare = /(^|\n)\s*(?:render|include)\s+(['"])([\w-]+)\2/g;
  let match;
  while ((match = tagged.exec(source))) names.push(match[2]);
  while ((match = bare.exec(source))) names.push(match[3]);
  return [...new Set(names)];
}

function extractAssetRefs(source) {
  const refs = new Set();
  const pattern = /['"]([\w./-]+\.(?:css|mjs|js|woff2?|png|jpe?g|svg|gif|webp|avif|eot|ttf|otf))['"]\s*\|\s*(?:asset_url|shopify_asset_url|stylesheet_tag|script_tag|preload_tag)/g;
  let match;
  while ((match = pattern.exec(source))) {
    if (!match[1].split('/').includes('..')) refs.add(match[1]);
  }
  return [...refs];
}

function collectSectionDependencies(storePath, source) {
  const snippets = new Set();
  const assets = new Set();
  const missingSnippets = new Set();
  const missingAssets = new Set();
  const visited = new Set();
  const visit = (text) => {
    for (const name of extractSnippetRefs(text)) {
      snippets.add(name);
      if (visited.has(name)) continue;
      visited.add(name);
      const full = path.join(storePath, 'snippets', `${name}.liquid`);
      try { visit(fs.readFileSync(full, 'utf8')); }
      catch { missingSnippets.add(name); }
    }
    for (const name of extractAssetRefs(text)) {
      assets.add(name);
      if (!fs.existsSync(path.join(storePath, 'assets', name))) missingAssets.add(name);
    }
  };
  visit(String(source || ''));
  return {
    snippets: [...snippets].sort(),
    assets: [...assets].sort(),
    missingSnippets: [...missingSnippets].sort(),
    missingAssets: [...missingAssets].sort(),
  };
}

module.exports = {
  parseJsonLoose,
  extractSchema,
  scanRenderEdits,
  extractSnippetRefs,
  extractAssetRefs,
  collectSectionDependencies,
};
