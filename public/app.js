/* Section Library frontend */
const $ = (id) => document.getElementById(id);

const state = {
  sections: [],
  stores: [],
  store: 'all',
  category: 'all',
  q: '',
  showFunctional: false,
  showPreviews: localStorage.getItem('sl-previews') !== 'off',
  current: null,   // section open in detail modal
  code: { liquid: '', css: '', js: '' },
  codeTab: 'liquid',
  editing: null,   // meta of section being edited (custom only)
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
    // duplicates collapse into their canonical entry; a store filter still
    // surfaces them when the group belongs to that store
    if (s.duplicate && !(state.store !== 'all' && (s.group || []).includes(state.store))) return false;
    if (state.store !== 'all' && !(s.group || [s.store]).includes(state.store)) return false;
    if (state.category !== 'all' && s.category !== state.category) return false;
    if (s.functional && !state.showFunctional) return false;
    if (q && !(`${s.name} ${s.file} ${s.store} ${s.category} ${(s.tags || []).join(' ')}`.toLowerCase().includes(q))) return false;
    return true;
  });
}

function counts() {
  const stores = { all: 0 }, cats = {};
  for (const s of state.sections) {
    if (s.duplicate && state.store === 'all') continue; // counted via their canonical group
    if (s.functional && !state.showFunctional) continue;
    const group = s.group || [s.store];
    stores.all++;
    for (const st of group) stores[st] = (stores[st] || 0) + 1;
    cats[s.category] = (cats[s.category] || 0) + 1;
  }
  return { stores, cats };
}

function renderSidebar() {
  const { stores, cats } = counts();
  const mk = (label, value, count, active) =>
    `<button class="side-item ${active ? 'active' : ''}" data-value="${value}"><span>${label}</span><span class="count">${count}</span></button>`;
  $('storeList').innerHTML =
    mk('All stores', 'all', stores.all, state.store === 'all') +
    state.stores.map((st) => mk(st.name, st.name, stores[st.name] || 0, state.store === st.name)).join('') +
    mk('Custom sections', 'custom', stores.custom || 0, state.store === 'custom');
  $('categoryList').innerHTML =
    mk('All categories', 'all', Object.values(cats).reduce((a, b) => a + b, 0), state.category === 'all') +
    Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([c, n]) =>
      mk(c, c, n, state.category === c)).join('');
  $('storeList').querySelectorAll('.side-item').forEach((b) =>
    b.onclick = () => { state.store = b.dataset.value; refresh(); });
  $('categoryList').querySelectorAll('.side-item').forEach((b) =>
    b.onclick = () => { state.category = b.dataset.value; refresh(); });
  $('sideFooter').textContent = `${state.sections.length} sections indexed · add a store folder to shopify-stores/ and re-run ingest`;
}

function renderGrid() {
  const list = visibleSections();
  $('grid').innerHTML = list.map((s) => `
    <div class="card" data-store="${s.store}" data-file="${s.file}">
      ${state.showPreviews ? `
      <div class="card-thumb">
        <span class="thumb-loading">loading preview…</span>
      </div>` : ''}
      <div class="card-top">
        <span class="cat-dot" style="background:${catColor(s.category)}"></span>
        <div class="card-name">${esc(s.name)}</div>
      </div>
      <div class="card-file">${esc(s.file)}</div>
      <div class="card-meta">
        <span class="chip store-chip">${s.store === 'custom' ? 'custom' : esc(s.store)}</span>
        ${(s.group && s.group.length > 1) ? `<span class="chip" title="also in: ${esc(s.group.filter(x => x !== s.store).join(', '))}">${s.group.length} stores</span>` : ''}
        <span class="chip">${esc(s.category)}</span>
        ${s.functional ? '<span class="chip functional">functional</span>' : ''}
        <span class="meta-dim">${s.settings} set · ${s.blocks} blk</span>
      </div>
    </div>`).join('');
  $('grid').querySelectorAll('.card').forEach((c) =>
    c.onclick = () => openDetail(c.dataset.store, c.dataset.file));
  $('empty').hidden = list.length > 0;
  const scope = [state.category !== 'all' && state.category, state.store !== 'all' && (state.store === 'custom' ? 'custom sections' : `store "${state.store}"`)].filter(Boolean).join(' · ');
  $('resultsTitle').textContent = state.q ? `Results for "${state.q}"` : (scope || 'All sections');
  $('resultsSub').textContent = `${list.length} section${list.length === 1 ? '' : 's'}${state.showFunctional ? '' : ' · functional hidden'}`;
  if (state.showPreviews) observeThumbs();
}

/* ------------------------- lazy live-preview thumbnails ------------------------ */

let thumbObserver = null;
let inFlight = 0;
const thumbQueue = [];

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
  if (el.dataset.loaded || !el.isConnected) { inFlight--; pumpThumbs(); return; }
  el.dataset.loaded = '1';
  inFlight++;
  const card = el.closest('.card');
  const frame = document.createElement('iframe');
  frame.title = 'preview';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.src = previewUrl({ store: card.dataset.store, file: card.dataset.file });
  frame.onload = () => {
    el.classList.add('loaded');
    inFlight--;
    pumpThumbs();
    requestAnimationFrame(() => {
      frame.style.transform = `scale(${el.clientWidth / 1200})`;
    });
  };
  frame.onerror = () => { el.classList.add('fail'); el.querySelector('.thumb-loading').textContent = 'preview failed'; inFlight--; pumpThumbs(); };
  el.appendChild(frame);
}

function refresh() { renderSidebar(); renderGrid(); }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------------------------- detail ----------------------------------- */

function previewUrl(s) {
  return s.store === 'custom' ? `/preview/custom/${s.file.replace(/\.liquid$/, '')}` : `/preview/${s.store}/${s.file}`;
}

async function openDetail(store, file) {
  const s = state.sections.find((x) => x.store === store && x.file === file);
  if (!s) return;
  state.current = s;
  const storeLabel = s.group && s.group.length > 1 ? `stores: ${s.group.join(', ')}` : (s.store === 'custom' ? 'Custom section' : `Store: ${s.store}`);
  $('detailKicker').textContent = `${storeLabel} · ${s.category}`;
  $('detailTitle').textContent = s.name;
  $('detailEdit').hidden = !s.custom;
  $('detailDelete').hidden = !s.custom;
  setDevice('desktop');
  $('detailFrame').src = previewUrl(s);
  const r = await fetch(`/api/section/${store}/${file}`).then((x) => x.json()).catch(() => null);
  state.code = r ? { liquid: r.liquid || '', css: r.css || '', js: r.js || '' } : { liquid: '', css: '', js: '' };
  state.codeTab = 'liquid';
  document.querySelectorAll('.code-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === 'liquid'));
  renderCode();
  $('detailOverlay').hidden = false;
}

function renderCode() {
  const tab = state.codeTab;
  const code = state.code[tab];
  const hints = {
    liquid: `${state.code.liquid.split('\n').length} lines — styles are inline in the section`,
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
}

async function deleteCustom(s) {
  if (!confirm(`Delete "${s.name}" from the library? This cannot be undone.`)) return;
  await fetch(`/api/custom/${s.file.replace(/\.liquid$/, '')}`, { method: 'DELETE' });
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

function openEditor(existing) {
  state.editing = existing || null;
  $('editorKicker').textContent = existing ? 'Edit custom section' : 'New section';
  $('editorTitle').textContent = existing ? existing.name : 'Add a section';
  $('fName').value = existing ? existing.name : '';
  $('fCategory').value = existing ? existing.category : 'Hero / Banner';
  $('fContext').value = existing ? (existing.contextStore || 'custom') : 'custom';
  $('fTags').value = existing ? (existing.tags || []).join(', ') : '';
  if (existing) {
    fetch(`/api/section/custom/${existing.file}`).then((r) => r.json()).then((d) => {
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
  $('editorOverlay').hidden = false;
  $('renderStatus').textContent = '';
}

function scheduleLivePreview(delay = 550) {
  clearTimeout(editorDebounce);
  editorDebounce = setTimeout(runLivePreview, delay);
}

async function runLivePreview() {
  $('renderStatus').textContent = 'rendering…';
  $('renderStatus').className = 'render-status';
  try {
    const r = await fetch('/api/render-preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        liquid: $('fLiquid').value, css: $('fCss').value, js: $('fJs').value,
        store: $('fContext').value === 'custom' ? 'custom' : $('fContext').value,
      }),
    }).then((x) => x.json());
    if (r.error) {
      $('renderStatus').textContent = 'render error';
      $('renderStatus').className = 'render-status err';
    } else {
      $('renderStatus').textContent = 'rendered ✓';
      $('renderStatus').className = 'render-status ok';
    }
    $('editorFrame').srcdoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/reset.css"><style>${$('fCss').value.replace(/<\/style/g, '')}</style></head><body>${r.html || ''}${r.error ? `<div style="position:fixed;inset:auto 14px 14px 14px;background:#7f1d1d;color:#fff;padding:12px 16px;border-radius:10px;font:13px/1.5 ui-monospace,monospace;white-space:pre-wrap">${esc(r.error)}</div>` : ''}<script>${$('fJs').value.replace(/<\/script/g, '')}<\/script></body></html>`;
  } catch (e) {
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
  const url = state.editing ? `/api/custom/${state.editing.file.replace(/\.liquid$/, '')}` : '/api/custom';
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
  $('editorOverlay').hidden = true;
  toast(state.editing ? 'Section updated & committed' : 'Section saved & committed to git');
  state.store = 'custom';
  state.category = 'all';
  await load();
}

/* ----------------------------------- boot ------------------------------------- */

async function load() {
  const idx = await fetch('/api/index').then((r) => r.json());
  state.sections = idx.sections;
  state.stores = idx.stores;
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

/* wire up */
$('search').addEventListener('input', (e) => { state.q = e.target.value; renderGrid(); });
$('functionalToggle').addEventListener('change', (e) => { state.showFunctional = e.target.checked; refresh(); });
$('previewsToggle').checked = state.showPreviews;
$('previewsToggle').addEventListener('change', (e) => {
  state.showPreviews = e.target.checked;
  localStorage.setItem('sl-previews', state.showPreviews ? 'on' : 'off');
  refresh();
});
$('addBtn').onclick = () => openEditor(null);
$('detailClose').onclick = () => { $('detailOverlay').hidden = true; };
$('detailOpenTab').onclick = () => state.current && window.open(previewUrl(state.current), '_blank');
$('detailCopy').onclick = () => state.current && copyText(state.code.liquid, 'Liquid copied');
$('detailDownload').onclick = () => state.current && downloadLiquid(state.current);
$('detailEdit').onclick = () => { $('detailOverlay').hidden = true; openEditor(state.current); };
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
  const labels = { liquid: 'Liquid copied', css: 'CSS copied', js: 'JS copied' };
  copyText(state.code[state.codeTab] || '', labels[state.codeTab]);
};
$('editorCancel').onclick = () => { $('editorOverlay').hidden = true; };
$('editorSave').onclick = saveEditor;
['fLiquid', 'fCss', 'fJs'].forEach((id) => $(id).addEventListener('input', () => scheduleLivePreview()));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { $('detailOverlay').hidden = true; $('editorOverlay').hidden = true; }
});

load();
