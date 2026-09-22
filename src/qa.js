// QA sweep: render every section locally (mock) and live (via proxy), verify
// CSS/JS/errors, write data/qa-report.json. Also warms the preview cache.
const fs = require('fs');
const path = require('path');
const { renderStoreSection } = require('./renderer');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.LIB_URL || 'http://localhost:4173';
const CONCURRENCY = 6;

const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/index.json'), 'utf8'));
const unique = index.sections.filter((s) => !s.duplicate && !s.empty);

/* --------------------------------- local pass -------------------------------- */

function checkLocalHtml(html, meta) {
  const issues = [];
  if (!html || html.trim().length < 40) issues.push('empty output');
  if (/\{\{\s*[\w.]+\s*[\w|:,'"]*\s*\}\}/.test(html)) issues.push('unrendered {{ }} leak');
  if (/\{%-?\s*(if|for|render|assign|schema|style)\b/.test(html)) issues.push('unrendered {% %} tag');
  const hasStyle = /<style[\s>]/.test(html);
  const hasCssAsset = (meta.assets || []).some((a) => a.endsWith('.css'));
  const hasClasses = /class="/.test(html);
  if (hasClasses && !hasStyle && !hasCssAsset && meta.lines > 40) issues.push('no styling source (no <style>, no css asset)');
  const expectsJs = (meta.assets || []).some((a) => a.endsWith('.js'));
  const hasScript = /<script/.test(html);
  if (expectsJs && !hasScript) issues.push('expected JS missing');
  if (/Liquid error/i.test(html)) issues.push('liquid error string');
  return issues;
}

async function localPass() {
  const results = [];
  let done = 0;
  for (const s of unique) {
    let entry;
    try {
      const r = await renderStoreSection(s.store, s.file);
      entry = { store: s.store, file: s.file, name: s.name, status: 'ok', issues: checkLocalHtml(r.html, s) };
      if (r.error) entry.issues.unshift(`render error: ${r.error.slice(0, 120)}`);
    } catch (e) {
      entry = { store: s.store, file: s.file, name: s.name, status: 'fail', issues: [String(e.message || e).slice(0, 160)] };
    }
    if (entry.issues.length) entry.status = entry.issues.some((i) => i.startsWith('render error')) ? 'fail' : 'warn';
    results.push(entry);
    done++;
    if (done % 100 === 0) console.log(`  local: ${done}/${unique.length}`);
  }
  return results;
}

/* ---------------------------------- live pass --------------------------------- */

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/gallery-manifest.json'), 'utf8'));

async function fetchOne(store, file) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 45000);
  try {
    const r = await fetch(`${BASE}/preview/${encodeURIComponent(store)}/${encodeURIComponent(file)}`, { signal: ctl.signal });
    const html = await r.text();
    const issues = [];
    if (r.status !== 200) issues.push(`http ${r.status}`);
    if (/password/i.test(html.slice(0, 3000)) && r.status === 200 && html.length < 5000) issues.push('password page');
    if (/Liquid error[^<]{0,120}/i.test(html)) issues.push((html.match(/Liquid error[^<]{0,120}/i) || [])[0]);
    if (r.status === 200 && html.length < 1200) issues.push(`suspiciously small (${html.length}b)`);
    if (!/shopify-section|<section|<style|asset_url|cdn\.shopify/.test(html)) issues.push('no section markup detected');
    return { store, file, status: issues.length ? 'warn' : 'ok', issues };
  } catch (e) {
    return { store, file, status: 'fail', issues: [String(e.message || e).slice(0, 120)] };
  } finally { clearTimeout(t); }
}

async function livePass() {
  const entries = Object.keys(manifest).filter((k) => {
    const s = index.sections.find((x) => `${x.store}/${x.file}` === k);
    return !s || !s.duplicate; // canonical entries only
  });
  const results = [];
  let idx = 0, done = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (idx < entries.length) {
      const key = entries[idx++];
      const [store, file] = key.split('/');
      const r = await fetchOne(store, file);
      results.push(r);
      done++;
      if (done % 50 === 0) console.log(`  live: ${done}/${entries.length}`);
    }
  });
  await Promise.all(workers);
  return results;
}

/* ----------------------------------- main ------------------------------------- */

(async () => {
  console.log(`QA: ${unique.length} unique sections, ${Object.keys(manifest).length} gallery entries`);
  console.log('— local mock pass —');
  const local = await localPass();
  console.log('— live store pass (also warms cache) —');
  const live = await livePass();

  const summarize = (rows) => ({
    ok: rows.filter((r) => r.status === 'ok').length,
    warn: rows.filter((r) => r.status === 'warn').length,
    fail: rows.filter((r) => r.status === 'fail').length,
  });
  const report = {
    generatedAt: new Date().toISOString(),
    local: { summary: summarize(local), results: local },
    live: { summary: summarize(live), results: live },
  };
  fs.writeFileSync(path.join(ROOT, 'data/qa-report.json'), JSON.stringify(report, null, 2));
  console.log('LOCAL', summarize(local));
  console.log('LIVE ', summarize(live));

  console.log('\n— worst offenders (local fails) —');
  for (const r of local.filter((r) => r.status === 'fail').slice(0, 15)) console.log(`  ${r.store}/${r.file}: ${r.issues[0]}`);
  console.log('— worst offenders (live) —');
  for (const r of live.filter((r) => r.status !== 'ok').slice(0, 20)) console.log(`  ${r.store}/${r.file}: ${r.issues.join(' | ')}`);
})();
