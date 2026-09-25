/* Section Library frontend */
const $ = (id) => document.getElementById(id);

const state = {
  sections: [],
  stores: [],
  storeColors: {},
  store: 'all',
  category: 'all',
  q: '',
  showFunctional: false,
  showPreviews: localStorage.getItem('sl-previews') !== 'off',
  columns: [2, 4].includes(Number(localStorage.getItem('sl-columns'))) ? Number(localStorage.getItem('sl-columns')) : 2,
  visibleCount: 48,
  current: null,   // section open in detail modal
  code: { liquid: '', css: '', js: '' },
  schema: null,
  dependencies: null,
  codeTab: 'liquid',
  editing: null,   // meta of section being edited (custom only)
  lastFocus: null,
};

const CAT_COLORS = {
  'Hero / Banner': '#c2571f', 'Product showcase': '#2f6f8f', 'Trust / Social proof': '#2f8f5b',
  'Testimonials': '#8f2f6b', 'Stats': '#b39322', 'Media': '#5b5bd6', 'CTA / Newsletter': '#c2478f',
  'Header / Footer / Nav': '#5d6b7a', 'Text / Content': '#6b7a2f', 'Other': '#8b8d93',
  'Functional / page': '#9a7ab5',
};
const catColor = (c) => CAT_COLORS[c] || '#8b8d93';

/* ---------------------------------- filtering --------------------------------- */

function visibleSections() {
  const q = state.q.trim().toLowerCase();
  return state.sections.filter((s) => {
    // Duplicates collapse into their canonical entry globally; picking a store
    // shows that store's own files (which is what the store actually contains).
    if (state.store === 'all' ? s.duplicate : s.store !== state.store) return false;
    if (state.category !== 'all' && s.category !== state.category) return false;
    if (s.functional && !state.showFunctional) return false;
    if (q && !(`${s.name} ${s.file} ${s.store} ${s.category} ${(s.tags || []).join(' ')}`.toLowerCase().includes(q))) return false;
    return true;
  });
}

function counts() {
  const stores = { all: 0 }, cats = {};
  // Store chips: own files per store (stable, scope-independent). Sharing info
  // still surfaces per-card via the "N stores" chip from the dedupe group.
  for (const s of state.sections) {
    if (s.functional && !state.showFunctional) continue;
    stores[s.store] = (stores[s.store] || 0) + 1;
  }
  // Headline + categories: current scope (store filter applied, dupes collapsed).
  for (const s of state.sections) {
    if (s.functional && !state.showFunctional) continue;
    if (state.store === 'all' ? s.duplicate : s.store !== state.store) continue;
    stores.all++;
    cats[s.category] = (cats[s.category] || 0) + 1;
  }
  return { stores, cats };
}

function renderSidebar() {
  const { stores, cats } = counts();
  const mk = (label, value, count, active, color) =>
    `<button type="button" class="side-item ${active ? 'active' : ''}" data-value="${esc(value)}">${color ? `<span class="side-dot" style="background:${esc(color)}"></span>` : ''}<span>${esc(label)}</span><span class="count">${count}</span></button>`;
  const colorOf = (name) => (state.storeColors[name] || {}).color;
  $('storeList').innerHTML =
    mk('All stores', 'all', stores.all, state.store === 'all') +
    state.stores.map((st) => mk(st.name, st.name, stores[st.name] || 0, state.store === st.name, colorOf(st.name))).join('') +
    mk('Custom sections', 'custom', stores.custom || 0, state.store === 'custom');
  $('categoryList').innerHTML =
    mk('All categories', 'all', Object.values(cats).reduce((a, b) => a + b, 0), state.category === 'all') +
    Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([c, n]) =>
      mk(c, c, n, state.category === c)).join('');
  $('storeList').querySelectorAll('.side-item').forEach((b) =>
    b.onclick = () => { state.store = b.dataset.value; refresh(); });
  $('categoryList').querySelectorAll('.side-item').forEach((b) =>
    b.onclick = () => { state.category = b.dataset.value; refresh(); });
  $('sideFooter').textContent = `${state.sections.length} sections indexed · add a store folder to stores/ and re-run ingest`;
}

function renderGrid() {
  const all = visibleSections();
  const list = all.slice(0, state.visibleCount);
  $('grid').style.setProperty('--columns', state.columns);
  $('grid').innerHTML = list.map((s) => {
    const dependencies = s.dependencies || {};
    const dependencyCount = (dependencies.snippets || []).length + (dependencies.assets || []).length;
    const quality = s.quality || { status: 'unverified' };
    const qualityText = { checked: 'render checked', review: 'needs review', failed: 'render issue', unverified: 'not checked' }[quality.status] || 'not checked';
    return `<button type="button" class="card" data-store="${esc(s.store)}" data-file="${esc(s.file)}" aria-label="Open ${esc(s.name)}">
      ${state.showPreviews ? `<div class="card-thumb"><span class="thumb-loading">loading preview…</span></div>` : ''}
      <div class="card-top">
        <span class="cat-dot" style="background:${catColor(s.category)}"></span>
        <div class="card-name">${esc(s.name)}</div>
      </div>
      <div class="card-file">${esc(s.file)}</div>
      <div class="card-meta">
        <span class="chip store-chip" style="${storeChipStyle(s.store === 'custom' ? null : s.store)}">${s.store === 'custom' ? 'custom' : esc(s.store)}</span>
        ${(s.group && s.group.length > 1) ? `<span class="chip" title="also in: ${esc(s.group.filter((x) => x !== s.store).join(', '))}">${s.group.length} stores</span>` : ''}
        ${dependencyCount ? `<span class="chip" title="includes ${dependencyCount} section-owned dependencies">${dependencyCount} dep${dependencyCount === 1 ? '' : 's'}</span>` : ''}
        ${s.schemaStatus === 'invalid' ? '<span class="chip warning">schema issue</span>' : ''}
        <span class="chip ${quality.status === 'failed' ? 'warning' : ''}" title="${esc((quality.issues || []).join(' · '))}">${qualityText}</span>
        <span class="chip">${esc(s.category)}</span>
        ${s.functional ? '<span class="chip functional">functional</span>' : ''}
        <span class="meta-dim">${s.settings || 0} set · ${s.blocks || 0} blk</span>
      </div>
    </button>`;
  }).join('');
  $('grid').querySelectorAll('.card').forEach((card) => {
    card.onclick = () => openDetail(card.dataset.store, card.dataset.file);
  });
  $('empty').hidden = all.length > 0;
  $('loadMore').hidden = all.length <= list.length;
  $('loadMore').textContent = `Load ${Math.min(48, all.length - list.length)} more sections`;
  const scope = [state.category !== 'all' && state.category, state.store !== 'all' && (state.store === 'custom' ? 'custom sections' : `store "${state.store}"`)].filter(Boolean).join(' · ');
  $('resultsTitle').textContent = state.q ? `Results for "${state.q}"` : (scope || 'All sections');
  $('resultsSub').textContent = `${all.length} section${all.length === 1 ? '' : 's'}${state.showFunctional ? '' : ' · functional hidden'}`;
  if (state.showPreviews) observeThumbs();
}

/* ------------------------- lazy live-preview thumbnails ------------------------ */

let thumbObserver = null;
let inFlight = 0;
const thumbQueue = [];
const THUMB_CANVAS_WIDTH = 1200;

function observeThumbs() {
  thumbObserver?.disconnect();
  const thumbs = [...document.querySelectorAll('.card-thumb:not(.loaded)')];
  if (!('IntersectionObserver' in window)) { thumbs.forEach(loadThumb); return; }
  thumbObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        thumbObserver.unobserve(e.target);
        queueThumb(e.target);
      }
    }
  }, { rootMargin: '300px' });
  thumbs.forEach((t) => thumbObserver.observe(t));
}

function queueThumb(el) {
  thumbQueue.push(el);
  pumpThumbs();
}

function pumpThumbs() {
  while (inFlight < 4 && thumbQueue.length) {
    loadThumb(thumbQueue.shift());
  }
}

function loadThumb(el) {
  if (!el.isConnected || el.dataset.loaded) { pumpThumbs(); return; }
  el.dataset.loaded = '1';
  inFlight++;
  const card = el.closest('.card');
  const frame = document.createElement('iframe');
  let settled = false;
  const finish = (failed = false) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (failed) {
      el.classList.add('fail');
      const loading = el.querySelector('.thumb-loading');
      if (loading) loading.textContent = 'preview failed';
    } else {
      el.classList.add('loaded');
      requestAnimationFrame(() => {
        const width = el.getBoundingClientRect().width || 320;
        frame.style.transform = `scale(${Math.min(1, width / THUMB_CANVAS_WIDTH)})`;
      });
    }
    inFlight--;
    pumpThumbs();
  };
  const timeout = setTimeout(() => finish(true), 15000);
  frame.title = 'preview';
  frame.loading = 'lazy';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.src = previewUrl({ store: card.dataset.store, file: card.dataset.file });
  frame.onload = () => finish();
  frame.onerror = () => finish(true);
  el.appendChild(frame);
}

function syncColumnButtons() {
  document.querySelectorAll('#columnSwitch button').forEach((button) => {
    const active = Number(button.dataset.columns) === state.columns;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function setColumns(value) {
  const count = Number(value);
  state.columns = count === 2 ? 2 : 4;
  localStorage.setItem('sl-columns', state.columns);
  syncColumnButtons();
  renderGrid();
}

function refresh({ reset = true } = {}) {
  if (reset) state.visibleCount = 48;
  renderSidebar();
  renderGrid();
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const storeChipStyle = (storeName) => {
  const c = state.storeColors[storeName];
  return c ? `background:${c.color};color:${c.textColor};border-color:transparent` : '';
};

/* ---------------------------------- detail ----------------------------------- */

function previewUrl(s) {
  const store = encodeURIComponent(s.store);
  const file = encodeURIComponent(s.store === 'custom' ? s.file.replace(/\.liquid$/, '') : s.file);
  return `/preview/${store}/${file}`;
}

let detailRequest = 0;
let detailController = null;
async function openDetail(store, file) {
  const s = state.sections.find((x) => x.store === store && x.file === file);
  if (!s) return;
  const request = ++detailRequest;
  state.current = s;
  state.dependencies = s.dependencies || null;
  const storeLabel = s.group && s.group.length > 1 ? `stores: ${s.group.join(', ')}` : (s.store === 'custom' ? 'Custom section' : `Store: ${s.store}`);
  $('detailKicker').textContent = `${storeLabel} · ${s.category}`;
  $('detailTitle').textContent = s.name;
  $('detailEdit').hidden = !s.custom;
  $('detailDelete').hidden = !s.custom;
  setDevice('desktop');
  $('detailFrame').src = previewUrl(s);
  state.lastFocus = state.lastFocus || document.activeElement;
  $('detailOverlay').hidden = false;
  requestAnimationFrame(() => $('detailClose').focus());
  detailController?.abort();
  detailController = new AbortController();
  try {
    const response = await fetch(`/api/section/${encodeURIComponent(store)}/${encodeURIComponent(file)}`, { signal: detailController.signal });
    const r = response.ok ? await response.json() : null;
    if (request !== detailRequest) return;
    state.code = r ? { liquid: r.liquid || '', css: r.css || '', js: r.js || '' } : { liquid: '', css: '', js: '' };
    state.schema = r ? r.schema : null;
    state.dependencies = r?.dependencies || s.dependencies || null;
    state.codeTab = 'liquid';
    document.querySelectorAll('.code-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === 'liquid'));
    renderCode();
  } catch (error) {
    if (error.name !== 'AbortError' && request === detailRequest) {
      state.code = { liquid: '', css: '', js: '' };
      state.schema = null;
      renderCode();
      toast('Could not load section source', true);
    }
  }
}

function renderSettingsHtml(schema) {
  if (!schema || !Array.isArray(schema.settings)) {
    return `<div class="settings-empty">No schema settings — this section has no theme-editor options${schema ? '' : ' (or its schema could not be parsed)'}.</div>`;
  }
  const row = (s) => {
    if (!s || !s.type || ['header', 'paragraph'].includes(s.type)) {
      if (s?.type === 'header') return `<div class="set-row" style="grid-template-columns:1fr"><span class="lbl" style="font-weight:700">${esc(s.content || '')}</span></div>`;
      if (s?.type === 'paragraph') return `<div class="set-row" style="grid-template-columns:1fr"><span style="color:var(--ink-3);font-size:11.5px">${esc(s.content || '')}</span></div>`;
      return '';
    }
    const def = s.default != null ? (typeof s.default === 'object' ? JSON.stringify(s.default) : String(s.default)) : '';
    const opts = Array.isArray(s.options) ? ` (${s.options.map((o) => o.value ?? o).join(' · ')})` : '';
    return `<div class="set-row">
      <span class="lbl" title="${esc(s.label || s.id || '')}">${esc(s.label || s.id || '')}</span>
      <span><span class="type-badge t-${esc(s.type)}">${esc(s.type)}</span></span>
      <span class="id" title="${esc(s.id || '')}">${esc(s.id || '')}</span>
      <span class="def" title="${esc(def + opts)}">${esc(def)}${esc(opts)}</span>
    </div>`;
  };
  const groupHtml = (title, list, countNote = '') => {
    if (!list || !list.length) return '';
    const visible = list.filter((s) => s && !['header', 'paragraph'].includes(s.type)).length;
    return `<div class="settings-group">
      <h3>${esc(title)} <span class="count">${visible} settings${countNote}</span></h3>
      ${list.map(row).join('')}
    </div>`;
  };
  const blocks = (schema.blocks || []).filter((b) => b && b.type !== '@app').map((b) => `
    <div class="settings-group">
      <h3>Block: ${esc(b.name || b.type)} <span class="count">type "${esc(b.type)}"${b.limit ? ` · max ${b.limit}` : ''}</span></h3>
      ${(b.settings || []).map(row).join('') || '<div class="set-row"><span style="color:var(--ink-3);font-size:11.5px">no settings</span></div>'}
    </div>`).join('');
  const presets = (schema.presets || []).map((p) => p.name).filter(Boolean);
  return `
    ${groupHtml('Section settings', schema.settings)}
    ${blocks}
    ${presets.length ? `<div class="settings-group"><h3>Presets <span class="count">${presets.length}</span></h3><div class="set-row"><span class="def">${esc(presets.join(' · '))}</span></div></div>` : ''}
    ${!schema.settings?.length && !blocks ? '<div class="settings-empty">Schema exists but declares no settings.</div>' : ''}
  `;
}

function renderDependenciesHtml(dependencies) {
  const snippets = dependencies?.snippets || [];
  const assets = dependencies?.assets || [];
  const missingSnippets = dependencies?.missingSnippets || [];
  const missingAssets = dependencies?.missingAssets || [];
  const list = (title, values, missing = []) => `<div class="settings-group"><h3>${esc(title)} <span class="count">${values.length}</span></h3>${values.length ? values.map((value) => `<div class="set-row"><span class="lbl">${esc(value)}</span><span>${missing.includes(value) ? '<span class="chip warning">missing</span>' : '<span class="chip">included</span>'}</span><span></span><span></span></div>`).join('') : '<div class="settings-empty">None detected</div>'}</div>`;
  return `${list('Snippets', snippets, missingSnippets)}${list('Assets', assets, missingAssets)}<div class="settings-empty">These are section-owned files. Theme-wide layout CSS and scripts may also be required.</div>`;
}

function renderCode() {
  const tab = state.codeTab;
  if (tab === 'settings' || tab === 'dependencies') {
    $('codeView').hidden = true;
    $('codeToolbar').hidden = true;
    $('settingsView').hidden = false;
    $('settingsView').innerHTML = tab === 'settings' ? renderSettingsHtml(state.schema) : renderDependenciesHtml(state.dependencies);
    return;
  }
  $('codeView').hidden = false;
  $('codeToolbar').hidden = false;
  $('settingsView').hidden = true;
  const code = state.code[tab];
  const hasInlineStyle = /<style[\s>]|{%-?\s*style\b|{%-?\s*stylesheet\b/.test(state.code.liquid);
  const hints = {
    liquid: `${state.code.liquid.split('\n').length} lines — ${state.code.css || hasInlineStyle ? 'section carries its own styles' : 'styled by the theme\u2019s global CSS'}`,
    css: code ? 'standalone CSS used by this section' : 'no standalone CSS — styling lives in the Liquid',
    js: code ? 'standalone JS used by this section' : 'no standalone JS for this section',
  };
  $('codeHint').textContent = hints[tab];
  $('codeView').textContent = code || '';
}

function setDevice(d) {
  const f = $('detailFrame');
  f.className = `d-${d}`;
  $('deviceHint').textContent = d === 'desktop' ? 'fluid' : d === 'tablet' ? '768px' : '390px';
  document.querySelectorAll('#deviceSwitch button').forEach((b) => b.classList.toggle('active', b.dataset.device === d));
}

async function copyText(t, msg) {
  try { await navigator.clipboard.writeText(t); toast(msg || 'Copied'); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = t; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove(); toast(msg || 'Copied');
  }
}

function downloadLiquid(s) {
  const blob = new Blob([state.code.liquid], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = s.file;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Source downloaded — install listed dependencies separately');
}

async function deleteCustom(s) {
  if (!confirm(`Delete "${s.name}" from the library? This cannot be undone.`)) return;
  const response = await fetch(`/api/custom/${encodeURIComponent(s.file.replace(/\.liquid$/, ''))}`, { method: 'DELETE' });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    toast(error.error || 'Delete failed', true);
    return;
  }
  $('detailOverlay').hidden = true;
  toast('Section deleted');
  await load();
}

/* ---------------------------------- editor ----------------------------------- */

const STARTER = `{% comment %}
  Describe what this section is for — future you will thank present you.
{% endcomment %}

<section class="my-section" id="MySection-{{ section.id }}">
  {%- style -%}
    #MySection-{{ section.id }} {
      --my-accent: {{ section.settings.accent }};
    }
    .my-section { padding: 72px 24px; text-align: center; }
    .my-section h2 { font-size: 40px; letter-spacing: -0.02em; margin-bottom: 12px; }
  {%- endstyle -%}

  <h2>{{ section.settings.heading }}</h2>
  <p>{{ section.settings.text }}</p>

  {% for block in section.blocks %}
    <div {{ block.shopify_attributes }}>{{ block.settings.title }}</div>
  {% endfor %}
</section>

{% schema %}
{
  "name": "My Section",
  "settings": [
    { "type": "text", "id": "heading", "label": "Heading", "default": "A headline that sells" },
    { "type": "textarea", "id": "text", "label": "Text", "default": "Supporting copy goes here." },
    { "type": "color", "id": "accent", "label": "Accent color", "default": "#2f6f4f" }
  ],
  "blocks": [
    { "type": "item", "name": "Item", "settings": [ { "type": "text", "id": "title", "label": "Title", "default": "Item title" } ] }
  ],
  "presets": [ { "name": "My Section", "blocks": [ { "type": "item" }, { "type": "item" }, { "type": "item" } ] } ]
}
{% endschema %}`;

let editorDebounce = null;
let editorRequest = 0;
let editorController = null;

function openEditor(existing) {
  state.editing = existing || null;
  $('editorKicker').textContent = existing ? 'Edit custom section' : 'New section';
  $('editorTitle').textContent = existing ? existing.name : 'Add a section';
  $('fName').value = existing ? existing.name : '';
  $('fCategory').value = existing ? existing.category : 'Hero / Banner';
  $('fContext').value = existing ? (existing.contextStore || 'custom') : 'custom';
  $('fTags').value = existing ? (existing.tags || []).join(', ') : '';
  if (existing) {
    fetch(`/api/section/custom/${encodeURIComponent(existing.file)}`).then((r) => r.json()).then((d) => {
      $('fLiquid').value = d.liquid || '';
      $('fCss').value = d.css || '';
      $('fJs').value = d.js || '';
      scheduleLivePreview(0);
    });
  } else {
    $('fLiquid').value = STARTER;
    $('fCss').value = '';
    $('fJs').value = '';
    scheduleLivePreview(0);
  }
  state.lastFocus = state.lastFocus || document.activeElement;
  $('editorOverlay').hidden = false;
  $('renderStatus').textContent = '';
  requestAnimationFrame(() => $('fName').focus());
}

function scheduleLivePreview(delay = 550) {
  clearTimeout(editorDebounce);
  editorDebounce = setTimeout(runLivePreview, delay);
}

async function runLivePreview() {
  const request = ++editorRequest;
  editorController?.abort();
  editorController = new AbortController();
  $('renderStatus').textContent = 'rendering…';
  $('renderStatus').className = 'render-status';
  try {
    const r = await fetch('/api/render-preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        liquid: $('fLiquid').value, css: $('fCss').value, js: $('fJs').value,
        store: $('fContext').value === 'custom' ? 'custom' : $('fContext').value,
      }),
      signal: editorController.signal,
    }).then((x) => x.json());
    if (request !== editorRequest) return;
    if (r.error) {
      $('renderStatus').textContent = 'render error';
      $('renderStatus').className = 'render-status err';
    } else {
      $('renderStatus').textContent = 'rendered ✓';
      $('renderStatus').className = 'render-status ok';
    }
    $('editorFrame').srcdoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><script>window.exports=window.exports||{};window.module=window.module||{exports:window.exports};window.require=window.require||function(){return{}};</script><link rel="stylesheet" href="/reset.css"><style>${$('fCss').value.replace(/<\/style/g, '')}</style></head><body>${r.html || ''}${r.error ? `<div style="position:fixed;inset:auto 14px 14px 14px;background:#7f1d1d;color:#fff;padding:12px 16px;border-radius:10px;font:13px/1.5 ui-monospace,monospace;white-space:pre-wrap">${esc(r.error)}</div>` : ''}<script>${$('fJs').value.replace(/<\/script/g, '')}<\/script></body></html>`;
  } catch (e) {
    if (e.name === 'AbortError' || request !== editorRequest) return;
    $('renderStatus').textContent = 'network error';
    $('renderStatus').className = 'render-status err';
  }
}

async function saveEditor() {
  const payload = {
    name: $('fName').value,
    category: $('fCategory').value,
    contextStore: $('fContext').value,
    tags: $('fTags').value,
    liquid: $('fLiquid').value,
    css: $('fCss').value,
    js: $('fJs').value,
  };
  const url = state.editing ? `/api/custom/${encodeURIComponent(state.editing.file.replace(/\.liquid$/, ''))}` : '/api/custom';
  const res = await fetch(url, {
    method: state.editing ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    toast(e.error || 'Save failed', true);
    return;
  }
  closeOverlay('editorOverlay');
  toast(state.editing ? 'Section updated & committed' : 'Section saved & committed to git');
  state.store = 'custom';
  state.category = 'all';
  await load();
}

/* ----------------------------------- boot ------------------------------------- */

async function load() {
  const response = await fetch('/api/index');
  if (!response.ok) throw new Error(`Index request failed (${response.status})`);
  const idx = await response.json();
  state.sections = idx.sections;
  state.stores = idx.stores;
  state.storeColors = Object.fromEntries(idx.stores.map((s) => [s.name, { color: s.color, textColor: s.textColor }]));
  const cats = [...new Set(idx.sections.map((s) => s.category))].sort();
  const catOptions = ['Hero / Banner', 'Product showcase', 'Trust / Social proof', 'Testimonials', 'Stats', 'Media', 'CTA / Newsletter', 'Header / Footer / Nav', 'Text / Content', ...cats.filter((c) => !['Hero / Banner', 'Product showcase', 'Trust / Social proof', 'Testimonials', 'Stats', 'Media', 'CTA / Newsletter', 'Header / Footer / Nav', 'Text / Content'].includes(c))];
  $('fCategory').innerHTML = catOptions.map((c) => `<option>${esc(c)}</option>`).join('');
  $('fContext').innerHTML = `<option value="custom">Standalone (no store)</option>` + idx.stores.map((s) => `<option value="${esc(s.name)}">Use ${esc(s.name)} theme data</option>`).join('');
  refresh();
}

function toast(msg, isErr) {
  const t = $('toast');
  t.textContent = msg;
  t.className = isErr ? 'toast err' : 'toast';
  t.hidden = false;
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.hidden = true; }, 2600);
}

function closeOverlay(id) {
  $(id).hidden = true;
  if (state.lastFocus?.isConnected) state.lastFocus.focus();
  state.lastFocus = null;
}

function trapOverlayFocus(event) {
  if (event.key !== 'Tab') return;
  const overlay = [...document.querySelectorAll('.overlay')].find((node) => !node.hidden);
  if (!overlay) return;
  const focusable = [...overlay.querySelectorAll('button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])')]
    .filter((node) => !node.disabled && node.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

/* wire up */
let searchTimer = null;
$('search').addEventListener('input', (e) => {
  state.q = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.visibleCount = 48; renderGrid(); }, 160);
});
$('loadMore').onclick = () => { state.visibleCount += 48; renderGrid(); };
$('functionalToggle').addEventListener('change', (e) => { state.showFunctional = e.target.checked; refresh(); });
syncColumnButtons();
$('columnSwitch').addEventListener('click', (e) => {
  const button = e.target.closest('button[data-columns]');
  if (button) setColumns(button.dataset.columns);
});
$('previewsToggle').checked = state.showPreviews;
$('previewsToggle').addEventListener('change', (e) => {
  state.showPreviews = e.target.checked;
  localStorage.setItem('sl-previews', state.showPreviews ? 'on' : 'off');
  refresh();
});
$('addBtn').onclick = () => openEditor(null);
$('detailClose').onclick = () => closeOverlay('detailOverlay');
$('detailOpenTab').onclick = () => state.current && window.open(previewUrl(state.current), '_blank', 'noopener,noreferrer');
$('detailCopy').onclick = () => state.current && copyText(state.code.liquid, 'Liquid copied');
$('detailDownload').onclick = () => state.current && downloadLiquid(state.current);
$('detailEdit').onclick = () => { closeOverlay('detailOverlay'); openEditor(state.current); };
$('detailDelete').onclick = () => state.current && deleteCustom(state.current);
$('previewReload').onclick = () => { const f = $('detailFrame'); f.src = f.src; };
$('deviceSwitch').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) setDevice(b.dataset.device);
});
document.querySelectorAll('.code-tab').forEach((t) =>
  t.onclick = () => {
    state.codeTab = t.dataset.tab;
    document.querySelectorAll('.code-tab').forEach((x) => x.classList.toggle('active', x === t));
    renderCode();
  });
$('codeCopy').onclick = () => {
  if (state.codeTab === 'dependencies') {
    copyText(JSON.stringify(state.dependencies || {}, null, 2), 'Dependencies copied');
    return;
  }
  const labels = { liquid: 'Liquid copied', css: 'CSS copied', js: 'JS copied' };
  copyText(state.code[state.codeTab] || '', labels[state.codeTab] || 'Copied');
};
$('editorCancel').onclick = () => closeOverlay('editorOverlay');
$('editorSave').onclick = saveEditor;
['fLiquid', 'fCss', 'fJs'].forEach((id) => $(id).addEventListener('input', () => scheduleLivePreview()));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const open = [...document.querySelectorAll('.overlay')].find((node) => !node.hidden);
    if (open) closeOverlay(open.id);
  }
  trapOverlayFocus(e);
});

load().catch(() => toast('Could not load the section library', true));
