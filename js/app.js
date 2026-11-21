import { kindOf, targetsFor, defaultTarget, LABEL, canonical, outputExt, detectImageCapabilities, detectMediaCapabilities } from './formats.js';
import { formatBytes, extOf, baseOf, escapeHtml, UserError } from './util.js';
import { convertOne, convertCombined, zipBlobs } from './convert.js';

const $ = (id) => document.getElementById(id);
const el = {
  intro: $('intro'), introTitle: $('introTitle'), work: $('work'), subject: $('subject'), target: $('target'), targetLabel: $('targetLabel'), menu: $('targetMenu'),
  opts: $('opts'), go: $('go'), saveAll: $('saveAll'), clear: $('clear'), picker: $('picker'),
  queue: $('queue'), rows: $('rows'), toast: $('toast'), theme: $('theme'),
};

const PREVIEWABLE = new Set(['jpg', 'png', 'webp', 'avif', 'gif', 'bmp', 'svg', 'ico']);

const state = {
  items: [],
  running: false,
  combinePdf: true,
  opts: { quality: 0.9, maxSide: 0, page: 'a4', dpi: 150, height: 0, bitrate: 192, gifWidth: 480, gifSeconds: 10 },
};
let uid = 0;

// ── Adding files ────────────────────────────────────────────────────────────

function addFiles(list) {
  const files = [...list].filter((f) => f.size > 0 || f.name);
  if (!files.length) return;
  const wasEmpty = !state.items.length;
  let unsupported = 0;
  let media = false;

  for (const file of files) {
    const kind = kindOf(file.name);
    if (!kind) unsupported++;
    if (kind === 'audio' || kind === 'video') media = true;
    state.items.push({
      id: ++uid, file, name: file.name, kind,
      target: kind ? defaultTarget(file.name) : null,
      status: kind ? 'ready' : 'unsupported',
      outputs: [], progress: null, error: '',
      thumb: PREVIEWABLE.has(canonical(extOf(file.name))) ? URL.createObjectURL(file) : null,
    });
  }
  alignTargets();
  if (unsupported) toast(unsupported === 1 ? 'One file isn’t a format Permute can convert yet.' : `${unsupported} files aren’t formats Permute can convert yet.`);
  render(wasEmpty);

  if (media) {
    detectMediaCapabilities().then(() => {
      for (const it of state.items) {
        if (it.status === 'ready' && !targetsFor(it.name).includes(it.target)) it.target = defaultTarget(it.name);
      }
      render();
    });
  }
}

/** If every file can become the same thing, start them all on one target. */
function alignTargets() {
  const live = state.items.filter((i) => i.kind && !i.result && i.status === 'ready');
  if (live.length < 2) return;
  const common = commonTargets();
  const firstPref = live[0].target;
  if (common.includes(firstPref) && live.every((i) => i.kind === live[0].kind)) live.forEach((i) => { i.target = firstPref; });
}

const liveItems = () => state.items.filter((i) => i.kind && !i.result);

function commonTargets() {
  const live = liveItems();
  if (!live.length) return [];
  return live.map((i) => targetsFor(i.name)).reduce((a, b) => a.filter((t) => b.includes(t)));
}

// ── Rendering ───────────────────────────────────────────────────────────────

function subjectText() {
  const live = liveItems();
  if (live.length === 1) return live[0].name;
  if (!live.length) return 'these files';
  const exts = new Set(live.map((i) => canonical(extOf(i.name))));
  if (exts.size === 1) {
    const label = LABEL[[...exts][0]] || [...exts][0].toUpperCase();
    return `${live.length} ${label} files`;
  }
  const kinds = new Set(live.map((i) => i.kind));
  const noun = { image: 'images', pdf: 'PDFs', document: 'documents', data: 'data files', audio: 'audio files', video: 'videos', archive: 'ZIPs' };
  return kinds.size === 1 ? `${live.length} ${noun[[...kinds][0]]}` : `${live.length} files`;
}

const targetLabel = (t, kind) => {
  if (t === 'pdf' && kind === 'pdf') return 'one merged PDF';
  if (t === 'zip') return 'a ZIP';
  if (t === 'txt') return 'plain text';
  return LABEL[t] || t.toUpperCase();
};

/** Long camera/WhatsApp names break the headline; keep the start and the end. */
function shortName(name, max = 26) {
  if (name.length <= max) return name;
  const ext = extOf(name);
  const tail = ext ? `.${ext}` : '';
  const stem = name.slice(0, name.length - tail.length);
  const keep = max - tail.length - 1;
  return `${stem.slice(0, Math.ceil(keep * 0.6))}…${stem.slice(-Math.floor(keep * 0.4))}${tail}`;
}

let menuOptions = [];
function renderHeadline() {
  const full = subjectText();
  el.subject.textContent = liveItems().length === 1 ? shortName(full, innerWidth < 560 ? 18 : 26) : full;
  el.subject.title = full;
  const live = liveItems();
  const common = commonTargets();
  const kinds = new Set(live.map((i) => i.kind));
  const soleKind = kinds.size === 1 ? [...kinds][0] : null;
  const chosen = new Set(live.map((i) => i.target));
  const current = chosen.size === 1 ? [...chosen][0] : '';

  menuOptions = common
    .filter((t) => !(t === 'pdf' && soleKind === 'pdf' && live.length < 2))
    .map((t) => ({ value: t, label: targetLabel(t, soleKind) }));
  const selected = menuOptions.find((o) => o.value === current);
  el.targetLabel.textContent = selected ? selected.label : live.length > 1 ? 'different formats' : 'choose a format';
  el.target.disabled = state.running || !menuOptions.length;
  el.menu.innerHTML = menuOptions.map((o) => `<li role="option" tabindex="-1" data-value="${o.value}" aria-selected="${o.value === current}">${escapeHtml(o.label)}</li>`).join('');
  if (el.target.disabled) closeMenu();
}

// ── Format menu (a native <select> renders its popup at the headline's size) ─

function openMenu() {
  if (el.target.disabled) return;
  el.menu.hidden = false;
  el.target.setAttribute('aria-expanded', 'true');
  const sel = el.menu.querySelector('[aria-selected="true"]') || el.menu.firstElementChild;
  sel?.focus();
}
function closeMenu(refocus = false) {
  if (el.menu.hidden) return;
  el.menu.hidden = true;
  el.target.setAttribute('aria-expanded', 'false');
  if (refocus) el.target.focus();
}
function chooseTarget(t) {
  closeMenu(true);
  for (const it of liveItems()) {
    if (it.status === 'working' || !targetsFor(it.name).includes(t)) continue;
    if (it.target !== t) { resetItem(it); it.target = t; }
  }
  dropStaleResults();
  render();
}
el.target.addEventListener('click', () => (el.menu.hidden ? openMenu() : closeMenu()));
el.target.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openMenu(); }
});
el.menu.addEventListener('click', (e) => {
  const li = e.target.closest('[data-value]');
  if (li) chooseTarget(li.dataset.value);
});
el.menu.addEventListener('keydown', (e) => {
  const items = [...el.menu.children];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); items[Math.min(items.length - 1, i + 1)]?.focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[Math.max(0, i - 1)]?.focus(); }
  else if (e.key === 'Home') { e.preventDefault(); items[0]?.focus(); }
  else if (e.key === 'End') { e.preventDefault(); items[items.length - 1]?.focus(); }
  else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (items[i]) chooseTarget(items[i].dataset.value); }
  else if (e.key === 'Escape' || e.key === 'Tab') { closeMenu(e.key === 'Escape'); }
});
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.pick')) closeMenu(); });

function activePairs() {
  return state.items.filter((i) => i.kind && !i.result && (i.status === 'ready' || i.status === 'done')).map((i) => [i.kind, i.target]);
}

function pdfCombineCandidates() {
  return state.items.filter((i) => i.status === 'ready' && i.target === 'pdf' && (i.kind === 'image' || i.kind === 'pdf'));
}

function renderOptions() {
  const pairs = activePairs();
  const has = (fn) => pairs.some(([k, t]) => fn(k, t));
  const controls = [];

  if (has((k, t) => (k === 'image' && ['jpg', 'webp', 'avif', 'pdf'].includes(t)) || (k === 'pdf' && ['jpg'].includes(t)))) {
    controls.push(`<label class="opt">Quality <input type="range" min="40" max="100" step="5" data-opt="quality" value="${Math.round(state.opts.quality * 100)}"><output>${Math.round(state.opts.quality * 100)}%</output></label>`);
  }
  if (has((k, t) => k === 'image' && t !== 'ico' && t !== 'zip')) {
    controls.push(select('maxSide', 'Size', [[0, 'Original'], [3840, 'Up to 3840 px'], [2560, 'Up to 2560 px'], [1600, 'Up to 1600 px'], [1080, 'Up to 1080 px'], [800, 'Up to 800 px']]));
  }
  if (has((k, t) => (k === 'image' || k === 'document') && t === 'pdf')) {
    const pages = [['a4', 'A4'], ['letter', 'US Letter']];
    if (has((k, t) => k === 'image' && t === 'pdf')) pages.push(['fit', 'Same as image']);
    controls.push(select('page', 'Page', pages));
  }
  if (has((k, t) => k === 'pdf' && (t === 'jpg' || t === 'png'))) {
    controls.push(select('dpi', 'Sharpness', [[72, 'Screen, 72 dpi'], [150, 'Standard, 150 dpi'], [300, 'Print, 300 dpi']]));
  }
  if (has((k, t) => k === 'video' && ['mp4', 'webm', 'mov', 'mkv'].includes(t))) {
    controls.push(select('height', 'Video size', [[0, 'Original'], [2160, 'Up to 4K'], [1080, 'Up to 1080p'], [720, 'Up to 720p'], [480, 'Up to 480p']]));
  }
  if (has((k, t) => ['mp3', 'm4a', 'ogg'].includes(t))) {
    controls.push(select('bitrate', 'Audio quality', [[128, '128 kbps'], [192, '192 kbps'], [256, '256 kbps'], [320, '320 kbps']]));
  }
  if (has((k, t) => t === 'gif-anim')) {
    controls.push(select('gifWidth', 'GIF width', [[320, '320 px'], [480, '480 px'], [640, '640 px']]));
    controls.push(select('gifSeconds', 'Length', [[5, 'First 5 s'], [10, 'First 10 s'], [20, 'First 20 s'], [30, 'First 30 s']]));
  }
  if (pdfCombineCandidates().length > 1) {
    controls.push(`<label class="opt opt-check"><input type="checkbox" data-opt="combinePdf" ${state.combinePdf ? 'checked' : ''}> Put them in one PDF</label>`);
  }
  el.opts.innerHTML = controls.join('');
  el.opts.querySelectorAll('select, input').forEach((c) => { c.disabled = state.running; });
}

function select(key, label, choices) {
  const opts = choices.map(([v, l]) => `<option value="${v}" ${String(state.opts[key]) === String(v) ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('');
  return `<label class="opt">${label} <select data-opt="${key}">${opts}</select></label>`;
}

const X_ICON = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8"/></svg>';

function rowHtml(it) {
  const ext = it.result ? outputExt(it.resultExt) : canonical(extOf(it.name));
  const thumb = it.thumb ? `<img src="${it.thumb}" alt="" loading="lazy" decoding="async">` : escapeHtml((ext || '?').slice(0, 4).toUpperCase());

  let meta = '';
  if (it.status === 'unsupported') meta = `.${escapeHtml(ext || 'unknown')} files can’t be converted yet`;
  else if (it.status === 'error') meta = escapeHtml(it.error);
  else if (it.result) meta = `${it.memberCount} files combined, ${formatBytes(it.outputs[0].blob.size)}`;
  else if (it.status === 'done' && it.mergedInto) meta = `${formatBytes(it.file.size)}, added to ${escapeHtml(it.mergedInto)}`;
  else if (it.status === 'done') {
    const out = it.outputs.reduce((n, o) => n + o.blob.size, 0);
    const what = it.outputs.length > 1 ? `${it.outputs.length} files, ${formatBytes(out)}` : `now ${formatBytes(out)}`;
    meta = `${formatBytes(it.file.size)}, <span class="${out < it.file.size ? 'smaller' : ''}">${what}</span>`;
    const notes = [...new Set(it.outputs.map((o) => o.note).filter(Boolean))];
    if (notes.length) meta += notes.map((n) => `<span class="note">${escapeHtml(n)}</span>`).join('');
  } else meta = formatBytes(it.file.size);

  let target = '';
  if (it.kind && !it.result && liveItems().length > 1) {
    const options = targetsFor(it.name).map((t) => `<option value="${t}" ${t === it.target ? 'selected' : ''}>${escapeHtml(targetLabel(t, it.kind))}</option>`).join('');
    target = `<label class="row-target"><span class="visually-hidden">Convert ${escapeHtml(it.name)} to</span><select data-row-target="${it.id}" ${state.running ? 'disabled' : ''}>${options}</select></label>`;
  } else target = '<span></span>';

  let end = '';
  if (it.status === 'working') end = `<span class="state">${it.progress == null ? 'Working' : `${Math.round(it.progress * 100)}%`}</span>`;
  else if (it.status === 'done' && it.outputs.length) end = `<button class="save" type="button" data-save="${it.id}">${it.outputs.length > 1 ? (it.target === 'unzip' ? `Save ${it.outputs.length} files` : `Save ${it.outputs.length} as ZIP`) : 'Save'}</button>`;
  else if (it.status === 'error') end = `<button class="save" type="button" data-retry="${it.id}">Try again</button>`;
  end += `<button class="remove" type="button" data-remove="${it.id}" aria-label="Remove ${escapeHtml(it.name)}" ${it.status === 'working' ? 'disabled' : ''}>${X_ICON}</button>`;

  const bar = it.status === 'working' ? `<span class="bar ${it.progress == null ? 'indeterminate' : ''}" data-bar="${it.id}"></span>` : '';
  return `<li class="row ${it.status}" data-id="${it.id}">
    <span class="thumb">${thumb}</span>
    <span class="info"><span class="name" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</span><span class="meta">${meta}</span></span>
    ${target}
    <span class="row-end">${end}</span>
    ${bar}
  </li>`;
}

function renderRows() {
  el.rows.innerHTML = state.items.map(rowHtml).join('');
  for (const it of state.items) if (it.status === 'working' && it.progress != null) setBar(it);
}

function setBar(it) {
  const bar = el.rows.querySelector(`[data-bar="${it.id}"]`);
  if (bar) bar.style.inlineSize = `${Math.round(it.progress * 100)}%`;
  const label = el.rows.querySelector(`[data-id="${it.id}"] .state`);
  if (label) label.textContent = `${Math.round(it.progress * 100)}%`;
}

function render(entering = false) {
  const any = state.items.length > 0;
  el.intro.hidden = any;
  el.work.hidden = !any;
  el.queue.hidden = !any;
  if (!any) return;

  if (entering) {
    el.work.classList.remove('enter');
    void el.work.offsetWidth; // restart the animation
    el.work.classList.add('enter');
  }
  renderHeadline();
  renderOptions();
  renderRows();

  const ready = state.items.filter((i) => i.status === 'ready').length;
  const outputs = savableOutputs();
  // Once everything is converted, saving becomes the main action.
  const allDone = !state.running && !ready && outputs.length > 0;
  el.go.hidden = allDone;
  el.go.disabled = state.running || !ready;
  el.go.textContent = state.running ? 'Converting…' : ready > 1 ? `Convert ${ready} files` : 'Convert';
  el.saveAll.hidden = !outputs.length || (!allDone && outputs.length < 2);
  el.saveAll.classList.toggle('btn-primary', allDone);
  el.saveAll.classList.toggle('btn-quiet', !allDone);
  el.saveAll.textContent = outputs.length === 1 ? `Save ${outputs[0].name}` : `Save all ${outputs.length} as ZIP`;
  el.clear.disabled = state.running;
}

// ── Converting ──────────────────────────────────────────────────────────────

function resetItem(it) {
  if (it.status === 'done' || it.status === 'error') {
    it.status = 'ready'; it.outputs = []; it.error = ''; it.progress = null; it.mergedInto = null;
  }
}

function progressFor(items) {
  let raf = 0;
  return (p) => {
    for (const it of items) it.progress = Math.max(0, Math.min(1, p));
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; items.forEach(setBar); });
  };
}

async function run() {
  if (state.running) return;
  const ready = state.items.filter((i) => i.status === 'ready');
  if (!ready.length) return;
  state.running = true;
  const controller = new AbortController();

  const groups = [];
  const pdfGroup = ready.filter((i) => i.target === 'pdf' && (i.kind === 'image' || i.kind === 'pdf'));
  const zipGroup = ready.filter((i) => i.target === 'zip');
  const grouped = new Set();
  if (state.combinePdf && pdfGroup.length > 1) { groups.push({ target: 'pdf', items: pdfGroup }); pdfGroup.forEach((i) => grouped.add(i)); }
  if (zipGroup.length > 1) { groups.push({ target: 'zip', items: zipGroup }); zipGroup.forEach((i) => grouped.add(i)); }
  for (const it of ready) if (!grouped.has(it)) groups.push({ target: it.target, items: [it] });

  for (const g of groups) { g.items.forEach((i) => { i.status = 'working'; i.progress = null; }); }
  render();

  for (const g of groups) {
    const opts = { ...state.opts };
    try {
      if (g.items.length > 1) {
        const outputs = await convertCombined(g.items.map((i) => i.file), g.target, opts, progressFor(g.items));
        const out = outputs[0];
        const result = {
          id: ++uid, result: true, resultExt: g.target, name: out.name, kind: null, status: 'done',
          outputs, memberCount: g.items.length, thumb: null,
        };
        const lastIndex = Math.max(...g.items.map((i) => state.items.indexOf(i)));
        state.items.splice(lastIndex + 1, 0, result);
        g.items.forEach((i) => { i.status = 'done'; i.outputs = []; i.mergedInto = out.name; });
      } else {
        const [it] = g.items;
        it.outputs = await convertOne(it.file, it.target, opts, progressFor([it]), controller.signal);
        it.status = 'done';
      }
    } catch (e) {
      console.error(e);
      const msg = e instanceof UserError ? e.message : `Something went wrong: ${e?.message || e}`;
      g.items.forEach((i) => { i.status = 'error'; i.error = msg; });
    }
    render();
  }
  state.running = false;
  render();

  const done = groups.filter((g) => g.items[0].status === 'done').length;
  if (done && done === groups.length) toast(done === 1 ? 'Converted.' : `Converted ${done} files.`);
}

// ── Saving ──────────────────────────────────────────────────────────────────

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function savableOutputs() {
  return state.items.filter((i) => i.status === 'done').flatMap((i) => i.outputs);
}

async function saveItem(it) {
  if (it.outputs.length === 1) return download(it.outputs[0].blob, it.outputs[0].name);
  if (it.target === 'unzip') {
    // Re-zipping files that just came out of a ZIP would be pointless; save each one.
    for (const o of it.outputs) { download(o.blob, o.name); await new Promise((r) => setTimeout(r, 200)); }
    return;
  }
  const zip = await zipBlobs(it.outputs, `${baseOf(it.name)}.zip`);
  download(zip.blob, zip.name);
}

async function saveAll() {
  const outputs = savableOutputs();
  if (!outputs.length) return;
  if (outputs.length === 1) return download(outputs[0].blob, outputs[0].name);
  el.saveAll.disabled = true;
  el.saveAll.textContent = 'Packing ZIP…';
  try {
    const zip = await zipBlobs(outputs, 'permute-converted.zip');
    download(zip.blob, zip.name);
  } finally {
    el.saveAll.disabled = false;
    render();
  }
}

// ── Removing ────────────────────────────────────────────────────────────────

function removeItem(id) {
  const i = state.items.findIndex((x) => x.id === id);
  if (i < 0) return;
  const [it] = state.items.splice(i, 1);
  if (it.thumb) URL.revokeObjectURL(it.thumb);
  render();
}

function clearAll() {
  state.items.forEach((it) => it.thumb && URL.revokeObjectURL(it.thumb));
  state.items = [];
  render();
}

// ── Events ──────────────────────────────────────────────────────────────────

el.picker.addEventListener('change', () => { addFiles(el.picker.files); el.picker.value = ''; });
el.go.addEventListener('click', run);
el.saveAll.addEventListener('click', saveAll);
el.clear.addEventListener('click', clearAll);


el.opts.addEventListener('input', (e) => {
  const key = e.target.dataset.opt;
  if (key === 'quality') e.target.nextElementSibling.textContent = `${e.target.value}%`;
});
el.opts.addEventListener('change', (e) => {
  const key = e.target.dataset.opt;
  if (!key) return;
  if (key === 'combinePdf') state.combinePdf = e.target.checked;
  else if (key === 'quality') state.opts.quality = Number(e.target.value) / 100;
  else if (key === 'page') state.opts.page = e.target.value;
  else state.opts[key] = Number(e.target.value);
  // New settings mean finished files should be converted again.
  state.items.forEach(resetItem);
  dropStaleResults();
  render();
});

el.rows.addEventListener('change', (e) => {
  const id = Number(e.target.dataset.rowTarget);
  const it = state.items.find((x) => x.id === id);
  if (!it) return;
  resetItem(it);
  it.target = e.target.value;
  dropStaleResults();
  render();
});

el.rows.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const find = (attr) => state.items.find((x) => x.id === Number(btn.dataset[attr]));
  if (btn.dataset.remove) removeItem(Number(btn.dataset.remove));
  else if (btn.dataset.save) saveItem(find('save'));
  else if (btn.dataset.retry) { resetItem(find('retry')); render(); }
});

/** A combined PDF/ZIP is stale once any of its source files is changed or reset. */
function dropStaleResults() {
  const names = new Set(state.items.filter((i) => i.mergedInto && i.status === 'done').map((i) => i.mergedInto));
  state.items = state.items.filter((i) => !i.result || names.has(i.name));
}

// Drag and drop anywhere on the page.
let dragDepth = 0;
let introIdle = '';
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (dragDepth++ === 0) {
    document.body.classList.add('dragging');
    const n = e.dataTransfer.items?.length || 0;
    introIdle ||= el.introTitle.innerHTML;
    el.introTitle.textContent = n > 1 ? `Let go to add ${n} files.` : 'Let go to add it.';
  }
});
window.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
const endDrag = () => {
  dragDepth = 0;
  document.body.classList.remove('dragging');
  if (introIdle) el.introTitle.innerHTML = introIdle;
};
window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) endDrag(); });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  endDrag();
  addFiles(e.dataTransfer.files);
});

// Paste images or files.
window.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  addFiles(files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${stamp}${files.length > 1 ? `-${i + 1}` : ''}.${extOf(f.name) || f.type.split('/')[1] || 'png'}`, { type: f.type }))));
});

window.addEventListener('beforeunload', (e) => { if (state.running) { e.preventDefault(); e.returnValue = ''; } });

// Theme toggle: dark by default, light if the person picks it.
function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'; // dark is Permute's default
}
function syncThemeLabel() {
  el.theme.setAttribute('aria-label', currentTheme() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
}
el.theme.addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  const apply = () => {
    if (next === 'light') document.documentElement.dataset.theme = 'light';
    else delete document.documentElement.dataset.theme;
    syncThemeLabel();
  };
  try { localStorage.setItem('permute-theme', next); } catch { /* fine */ }
  // Cross-fade the whole page (timing lives in CSS). Instant where unsupported or motion is reduced.
  if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) document.startViewTransition(apply);
  else apply();
});
syncThemeLabel();

let toastTimer;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 3200);
}

// ── Start ───────────────────────────────────────────────────────────────────

detectImageCapabilities().then(() => render());
let resizeRaf = 0;
window.addEventListener('resize', () => { cancelAnimationFrame(resizeRaf); resizeRaf = requestAnimationFrame(() => { if (state.items.length) renderHeadline(); }); });
render();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is a bonus */ });
}
