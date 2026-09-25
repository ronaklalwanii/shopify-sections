// QA sweep: render every section locally (mock) and live (via proxy), verify
// CSS/JS/errors, write data/qa-report.json. Also warms the preview cache.
// test commit to check custom sections before pushing to gallery. Run with QA_LIVE=1 to test live store rendering.
const fs = require("fs");
const path = require("path");
const { renderStoreSection } = require("./renderer");
const { ensureIndex } = require("./ensure-index");

// QA reads the index directly, so make sure it reflects stores/ before sweeping.
ensureIndex({ log: (m) => console.log(`[index] ${m}`) });

const ROOT = path.resolve(__dirname, "..");
const BASE = process.env.LIB_URL || "http://localhost:4173";
const LIVE_QA = process.env.QA_LIVE === "1";
const CONCURRENCY = 6;

const index = JSON.parse(
  fs.readFileSync(path.join(ROOT, "data/index.json"), "utf8"),
);
const unique = index.sections.filter((s) => !s.duplicate && !s.empty);

/* --------------------------------- local pass -------------------------------- */

// Stores whose layout (or its snippets) loads global CSS — their sections are
// styled even without inline <style> or per-section asset refs.
const globalCssCache = new Map();
function storeHasGlobalCss(store) {
  if (globalCssCache.has(store)) return globalCssCache.get(store);
  let has = false;
  try {
    const { findStore } = require("./roots");
    const storePath = findStore(store);
    const scan = (text) =>
      /['"]([\w./-]+\.css)['"]\s*\|\s*asset_url/.test(text);
    const layout = fs.readFileSync(
      path.join(storePath, "layout/theme.liquid"),
      "utf8",
    );
    has = scan(layout);
    if (!has) {
      const snipRe = /{%[-\s]*render\s+'([\w-]+)'/g;
      let m;
      while (!has && (m = snipRe.exec(layout))) {
        try {
          has = scan(
            fs.readFileSync(
              path.join(storePath, "snippets", `${m[1]}.liquid`),
              "utf8",
            ),
          );
        } catch {}
      }
    }
  } catch {
    has = false;
  }
  globalCssCache.set(store, has);
  return has;
}

function visibleContentIssues(html) {
  const markup = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const text = markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|amp|lt|gt|quot|#39);/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const hasMedia =
    /<(?:img|svg|video|picture|source|hr|input)\b/i.test(html) ||
    /url\(/i.test(html) ||
    /class=["'][^"']*\bdivider(?:__|--|\b)/i.test(html);
  return text || hasMedia ? [] : ["no visible content"];
}

function hardIssue(issue) {
  if (/^core file wrapper/i.test(issue)) return false;
  return /empty output|no visible content|unrendered|liquid error|render error|http [45]|network|aborted/i.test(
    issue,
  );
}

function checkLocalHtml(html, meta) {
  const issues = [];
  const noVisible = visibleContentIssues(html);
  if (meta.usesContentFor && noVisible.length)
    issues.push("needs Shopify block context");
  else {
    if (!html || html.trim().length < 40)
      issues.push(
        meta.core
          ? "core file wrapper has no standalone output"
          : "empty output",
      );
    if (meta.core)
      issues.push(...noVisible.map((issue) => `core file wrapper: ${issue}`));
    else issues.push(...noVisible);
  }
  // Leak checks ignore script/style bodies: JS money formatters legitimately
  // contain {{amount}}, and CSS can hold template-looking text. Money-format
  // placeholders in data attributes (e.g. data-money-format="${{amount}}")
  // are correct Shopify output, not leaks.
  const markup = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/{{amount[^}]*}}/g, "");
  if (/\{\{\s*[\w.]+\s*[\w|:,'"]*\s*\}\}/.test(markup))
    issues.push("unrendered {{ }} leak");
  if (/\{%-?\s*(if|for|render|assign|schema|style)\b/.test(markup))
    issues.push("unrendered {% %} tag");
  const hasStyle = /<style[\s>]/.test(html);
  const hasCssAsset = (meta.assets || []).some((a) => a.endsWith(".css"));
  const hasClasses = /class="/.test(html);
  if (
    hasClasses &&
    !hasStyle &&
    !hasCssAsset &&
    !storeHasGlobalCss(meta.store) &&
    meta.lines > 40
  ) {
    issues.push(
      "no styling source (no <style>, no css asset, no global layout CSS)",
    );
  }
  // NOTE: no "expected JS" check here by design — section JS assets are wired
  // up at preview assembly (server.js inlines them); asset refs are often
  // conditional ({% if section.blocks.size > 1 %}) so a fragment can't tell.
  if (/Liquid error/i.test(html)) issues.push("liquid error string");
  return issues;
}

async function localPass() {
  const results = [];
  let done = 0;
  for (const s of unique) {
    let entry;
    try {
      const r = await renderStoreSection(s.store, s.file);
      entry = {
        store: s.store,
        file: s.file,
        name: s.name,
        status: "ok",
        issues: checkLocalHtml(r.html, s),
      };
      if (r.error)
        entry.issues.unshift(`render error: ${r.error.slice(0, 120)}`);
    } catch (e) {
      entry = {
        store: s.store,
        file: s.file,
        name: s.name,
        status: "fail",
        issues: [String(e.message || e).slice(0, 160)],
      };
    }
    if (entry.issues.length)
      entry.status = entry.issues.some(hardIssue) ? "fail" : "warn";
    results.push(entry);
    done++;
    if (done % 100 === 0) console.log(`  local: ${done}/${unique.length}`);
  }
  return results;
}

/* ---------------------------------- live pass --------------------------------- */

const manifest = JSON.parse(
  fs.readFileSync(path.join(ROOT, "data/gallery-manifest.json"), "utf8"),
);

async function fetchOne(store, file) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 45000);
  try {
    const liveQuery = LIVE_QA ? "?live=1" : "";
    const r = await fetch(
      `${BASE}/preview/${encodeURIComponent(store)}/${encodeURIComponent(file)}${liveQuery}`,
      { signal: ctl.signal },
    );
    const html = await r.text();
    const previewPath = r.headers.get("x-preview-path") || "unknown";
    const issues = visibleContentIssues(html).filter(
      (issue) =>
        previewPath !== "local-context" || issue !== "no visible content",
    );
    if (r.status !== 200) issues.push(`http ${r.status}`);
    // Password templates legitimately contain password copy — only flag it
    // when the section itself isn't a password page.
    if (
      !/password/i.test(file) &&
      /password/i.test(html.slice(0, 3000)) &&
      r.status === 200 &&
      html.length < 5000
    )
      issues.push("password page");
    if (/Liquid error[^<]{0,120}/i.test(html))
      issues.push((html.match(/Liquid error[^<]{0,120}/i) || [])[0]);
    if (
      r.status === 200 &&
      previewPath !== "local-context" &&
      html.length < 1200
    )
      issues.push(`suspiciously small (${html.length}b)`);
    if (!/shopify-section|<section|<style|asset_url|cdn\.shopify/.test(html))
      issues.push("no section markup detected");
    if (previewPath === "local") issues.push("local fallback");
    if (previewPath === "local-context")
      issues.push("needs Shopify block context");
    return {
      store,
      file,
      previewPath,
      status: issues.some(hardIssue) ? "fail" : issues.length ? "warn" : "ok",
      issues,
    };
  } catch (e) {
    return {
      store,
      file,
      status: "fail",
      issues: [String(e.message || e).slice(0, 120)],
    };
  } finally {
    clearTimeout(t);
  }
}

async function livePass() {
  const entries = Object.keys(manifest).filter((k) => {
    const s = index.sections.find((x) => `${x.store}/${x.file}` === k);
    return !s || !s.duplicate; // canonical entries only
  });
  const results = [];
  let idx = 0,
    done = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (idx < entries.length) {
      const key = entries[idx++];
      const [store, file] = key.split("/");
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

async function main() {
  console.log(
    `QA: ${unique.length} unique sections, ${Object.keys(manifest).length} gallery entries`,
  );
  console.log("— local mock pass —");
  const local = await localPass();
  const runLive = process.env.QA_SKIP_LIVE !== "1";
  console.log(
    runLive
      ? "— live store pass (also warms cache) —"
      : "— live store pass skipped —",
  );
  const live = runLive ? await livePass() : [];

  const summarize = (rows) => ({
    ok: rows.filter((r) => r.status === "ok").length,
    warn: rows.filter((r) => r.status === "warn").length,
    fail: rows.filter((r) => r.status === "fail").length,
  });
  const report = {
    generatedAt: new Date().toISOString(),
    mode: runLive ? "server-render" : "local-render",
    local: { summary: summarize(local), results: local },
    live: { summary: summarize(live), results: live },
  };
  fs.writeFileSync(
    path.join(ROOT, "data/qa-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log("LOCAL", summarize(local));
  console.log("LIVE ", summarize(live));

  console.log("\n— worst offenders (local fails) —");
  for (const r of local.filter((r) => r.status === "fail").slice(0, 15))
    console.log(`  ${r.store}/${r.file}: ${r.issues[0]}`);
  console.log("— worst offenders (live) —");
  for (const r of live.filter((r) => r.status !== "ok").slice(0, 20))
    console.log(`  ${r.store}/${r.file}: ${r.issues.join(" | ")}`);
  if (
    local.some((row) => row.status === "fail") ||
    live.some((row) => row.status === "fail")
  )
    process.exitCode = 1;
}

if (require.main === module) main();
module.exports = {
  checkLocalHtml,
  visibleContentIssues,
  hardIssue,
  localPass,
  fetchOne,
};
