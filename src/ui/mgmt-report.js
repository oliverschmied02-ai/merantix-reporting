/**
 * Management Report — P&L for a chosen set of months with a free-text comment
 * next to every line item, plus an executive summary.
 *
 * Columns: YTD (Jan through the latest selected month) on the left, then one
 * column per selected month, then the comment. Comments auto-save per user,
 * year and month selection. "Mit Claude analysieren" asks the server for an
 * executive summary and per-line comment suggestions that can be accepted.
 * The report exports to PDF via the print dialog.
 */

import { APP } from '../state.js';
import { esc, MONTH_SHORT } from '../lib/utils.js';
import { computePLSingle } from '../lib/compute.js';
import { getSetting, saveSetting, loadTransactionsForYear, analyzeReport } from '../lib/db.js';
import { showToast } from './screen.js';
import { onClick, onInput } from './dispatch.js';

// ── Module state ──────────────────────────────────────────────────────

let _year    = null;
let _months  = [];                 // selected months, sorted ascending, never empty once set
let _notes   = { summary: '', comments: {} };
let _rows    = [];                 // last rendered rows (shared with PDF export)
let _ai      = null;               // { status: 'loading'|'done'|'error', sig, summary, comments, error }
let _saveTimer = null;
let _dirty   = false;

const SAVE_DELAY = 800;
const FMT = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

const PRESETS = {
  Q1: [1, 2, 3], Q2: [4, 5, 6], Q3: [7, 8, 9], Q4: [10, 11, 12],
  H1: [1, 2, 3, 4, 5, 6], H2: [7, 8, 9, 10, 11, 12],
};

// ── Entry point ───────────────────────────────────────────────────────

export async function openReportScreen() {
  const years = [...new Set(APP.years || [])].sort((a, b) => b - a);
  if (!_year || !years.includes(_year)) {
    const plYear = parseInt(document.getElementById('year-sel')?.value);
    _year = years.includes(plYear) ? plYear : (years[0] ?? null);
    _months = [];
  }
  populateYearSelector(years);
  if (!_year) { renderEmpty('Keine Buchungsdaten geladen. Bitte zuerst eine GDPdU-Datei importieren.'); return; }

  await ensureYearLoaded(_year);
  if (!_months.length) _months = [latestMonthWithData(_year)];
  await loadNotes();
  render();
}

// ── Selection ─────────────────────────────────────────────────────────

function populateYearSelector(years) {
  const sel = document.getElementById('mr-year-sel');
  if (!sel) return;
  sel.innerHTML = years.length
    ? years.map(y => `<option value="${y}" ${y === _year ? 'selected' : ''}>${y}</option>`).join('')
    : `<option value="">—</option>`;
}

export async function mrChangeYear() {
  await flushSave();
  _year = parseInt(document.getElementById('mr-year-sel')?.value) || null;
  if (!_year) return;
  await ensureYearLoaded(_year);
  await setMonths([latestMonthWithData(_year)]);
}

export async function mrToggleMonth(m) {
  const has = _months.includes(m);
  if (has && _months.length === 1) return; // keep at least one month selected
  await setMonths(has ? _months.filter(x => x !== m) : [..._months, m]);
}

export async function mrPreset(name) {
  if (name === 'ALL') return setMonths([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  if (name === 'YTD') {
    const last = latestMonthWithData(_year);
    return setMonths(Array.from({ length: last }, (_, i) => i + 1));
  }
  if (PRESETS[name]) return setMonths(PRESETS[name]);
}

async function setMonths(months) {
  await flushSave();
  _months = [...new Set(months)].sort((a, b) => a - b);
  _ai = null;
  await loadNotes();
  render();
}

const ytdEnd = () => Math.max(..._months);
const selectionSig = () => `${_year}_M${_months.join('-')}`;

function selectionLabel() {
  const names = _months.map(m => MONTH_SHORT[m - 1]);
  const contiguous = _months.every((m, i) => i === 0 || m === _months[i - 1] + 1);
  if (_months.length > 2 && contiguous) return `${names[0]}–${names[names.length - 1]} ${_year}`;
  return `${names.join(', ')} ${_year}`;
}

const ytdLabel = () => ytdEnd() === 1 ? 'YTD Jan' : `YTD Jan–${MONTH_SHORT[ytdEnd() - 1]}`;

function latestMonthWithData(year) {
  const months = APP.allTransactions.filter(t => t.wjYear === year).map(t => t.wjMonth).filter(Boolean);
  return months.length ? Math.max(...months) : 12;
}

function monthsWithData(year) {
  return new Set(APP.allTransactions.filter(t => t.wjYear === year).map(t => t.wjMonth));
}

async function ensureYearLoaded(year) {
  if (!APP.loadedYears || APP.loadedYears.has(year)) return;
  const el = document.getElementById('mr-content');
  if (el) el.innerHTML = `<div class="plan-loading">Lade ${year}…</div>`;
  try {
    const data = await loadTransactionsForYear(year);
    APP.allTransactions = APP.allTransactions.filter(t => t.wjYear !== year);
    APP.allTransactions.push(...data);
    APP.loadedYears.add(year);
  } catch (e) {
    showToast('Fehler beim Laden des Jahres ' + year + ': ' + e.message);
  }
}

// ── Notes persistence (per user, per year + month selection) ──────────

const notesKey = () => `mgmt_report_v1_${selectionSig()}`;

async function loadNotes() {
  _notes = { summary: '', comments: {} };
  _dirty = false;
  setStatus('');
  try {
    const saved = await getSetting(notesKey());
    if (saved && typeof saved === 'object') {
      _notes = { summary: saved.summary || '', comments: saved.comments || {} };
    }
  } catch { /* start empty */ }
}

function scheduleSave() {
  _dirty = true;
  setStatus('dirty');
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => { _saveTimer = null; doSave(); }, SAVE_DELAY);
}

async function doSave() {
  if (!_dirty) return;
  _dirty = false;
  setStatus('saving');
  const key = notesKey();
  const comments = {};
  for (const [k, v] of Object.entries(_notes.comments)) if (v && v.trim()) comments[k] = v;
  try {
    await saveSetting(key, { summary: _notes.summary, comments });
    setStatus(_dirty ? 'dirty' : 'saved');
  } catch (e) {
    _dirty = true;
    setStatus('error');
    showToast('Kommentare konnten nicht gespeichert werden: ' + e.message);
  }
}

async function flushSave() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  if (_dirty) await doSave();
}

function setStatus(state) {
  const el = document.getElementById('mr-save-status');
  if (!el) return;
  const map = {
    dirty:  '<span class="pss pss-dirty">● Nicht gespeichert</span>',
    saving: '<span class="pss pss-saving">Speichert…</span>',
    saved:  '<span class="pss pss-saved">✓ Gespeichert</span>',
    error:  '<span class="pss pss-error">⚠ Fehler beim Speichern</span>',
  };
  el.innerHTML = map[state] ?? '';
}

export function mrCommentInput(key, el) {
  _notes.comments[key] = el.value;
  autoGrow(el);
  scheduleSave();
}

export function mrSummaryInput(el) {
  _notes.summary = el.value;
  autoGrow(el);
  scheduleSave();
}

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

// ── Row model ─────────────────────────────────────────────────────────

/**
 * Build display rows for the selected months. Values are signed for display:
 * costs negative, income positive (computed rows as calculated).
 * Each row: { key, style: 'section'|'sub'|'computed'|'final'|'ratio', label,
 *             ytd, months: { [m]: value } }
 */
function buildRows() {
  const yearTxns = APP.allTransactions.filter(t => t.wjYear === _year);
  const monthPL = Object.fromEntries(_months.map(m => [m, computePLSingle(yearTxns.filter(t => t.wjMonth === m))]));
  const yPL = computePLSingle(yearTxns.filter(t => t.wjMonth >= 1 && t.wjMonth <= ytdEnd()));

  const keep = key => !!(_notes.comments[key]?.trim() || _ai?.comments?.[key]);
  const perMonth = fn => Object.fromEntries(_months.map(m => [m, fn(monthPL[m])]));
  const rows = [];

  for (const item of APP.plDef) {
    if (item.type === 'computed' || item.type === 'ratio') {
      const val = pl => pl.computed[item.id] ?? (item.type === 'ratio' ? null : 0);
      rows.push({
        key: item.id, label: item.label,
        style: item.type === 'ratio' ? 'ratio' : item.level === 'final' ? 'final' : 'computed',
        ytd: val(yPL), months: perMonth(val),
      });
      continue;
    }

    const nb = item.normalBalance || 'S';
    const isMixed = item.type === 'section_mixed';
    const sectionVal = pl => isMixed ? (pl.computed[item.id] || 0)
      : (nb === 'S' ? -1 : 1) * (pl.vals[item.id]?.amount || 0);
    rows.push({ key: item.id, style: 'section', label: item.label, ytd: sectionVal(yPL), months: perMonth(sectionVal) });

    for (const sub of item.subs || []) {
      const snb = sub.normalBalance || nb;
      const subVal = pl => (snb === 'S' ? -1 : 1) * (pl.vals[item.id]?.bySubId[sub.id]?.amount || 0);
      const key = `${item.id}::${sub.id}`;
      const ytd = subVal(yPL);
      const months = perMonth(subVal);
      if (ytd === 0 && Object.values(months).every(v => v === 0) && !keep(key)) continue;
      rows.push({ key, style: 'sub', label: sub.label, ytd, months });
    }
  }
  return rows;
}

function fmtVal(v, style) {
  if (style === 'ratio') return (v === null || v === undefined) ? '—' : v.toFixed(1).replace('.', ',') + ' %';
  if (!v || Math.round(v) === 0) return '—';
  const s = FMT.format(Math.abs(Math.round(v)));
  return v < 0 ? `−${s}` : s;
}

const negCls = (v, style) => (style !== 'ratio' && v < 0) ? ' neg' : '';
const multiline = s => esc(s).replace(/\n/g, '<br>');

// ── Claude analysis ───────────────────────────────────────────────────

export async function mrAnalyze() {
  if (!_rows.length || _ai?.status === 'loading') return;
  await flushSave();
  const sig = selectionSig();
  _ai = { status: 'loading', sig };
  render();

  const payload = {
    year: _year,
    months: _months,
    rows: _rows.map(r => ({ key: r.key, label: r.label, style: r.style, ytd: r.ytd, months: r.months })),
    summary: _notes.summary,
    comments: _notes.comments,
    company: (APP.loadedFiles || []).map(f => f.companyName).filter(Boolean).join(', '),
  };

  try {
    const result = await analyzeReport(payload);
    if (selectionSig() !== sig) return; // selection changed while waiting
    _ai = { status: 'done', sig, summary: result.summary || '', comments: result.comments || {} };
  } catch (e) {
    if (selectionSig() !== sig) return;
    _ai = { status: 'error', sig, error: e.message };
  }
  render();
}

export function mrCloseAnalysis() {
  _ai = null;
  render();
}

export function mrAcceptSummary() {
  if (!_ai?.summary) return;
  const cur = _notes.summary.trim();
  _notes.summary = cur ? `${cur}\n\n${_ai.summary}` : _ai.summary;
  scheduleSave();
  render();
}

export function mrAcceptComment(key) {
  const s = _ai?.comments?.[key];
  if (!s) return;
  const cur = (_notes.comments[key] || '').trim();
  _notes.comments[key] = cur ? `${cur}\n${s}` : s;
  delete _ai.comments[key];
  scheduleSave();
  render();
}

export function mrAcceptAllComments() {
  if (!_ai?.comments) return;
  let filled = 0, skipped = 0;
  for (const [key, s] of Object.entries(_ai.comments)) {
    if ((_notes.comments[key] || '').trim()) { skipped++; continue; }
    _notes.comments[key] = s;
    delete _ai.comments[key];
    filled++;
  }
  if (filled) scheduleSave();
  showToast(
    `${filled} Kommentar${filled === 1 ? '' : 'e'} übernommen` +
    (skipped ? ` · ${skipped} bei bestehenden Kommentaren nicht überschrieben` : ''),
    'success',
  );
  render();
}

function renderAiPanel() {
  if (!_ai) return '';
  if (_ai.status === 'loading') {
    return `<section class="mr-ai mr-ai-loading">
      <span class="mr-ai-spinner"></span>
      Claude analysiert ${esc(selectionLabel())}… das dauert meist 20–60 Sekunden.
    </section>`;
  }
  if (_ai.status === 'error') {
    return `<section class="mr-ai mr-ai-error">
      <div class="mr-ai-head"><strong>Analyse fehlgeschlagen</strong>
        <button class="mr-ai-close" ${onClick('mrCloseAnalysis')} title="Schließen">✕</button></div>
      <div>${esc(_ai.error)}</div>
    </section>`;
  }
  const n = Object.keys(_ai.comments).length;
  return `<section class="mr-ai">
    <div class="mr-ai-head">
      <strong>✨ Analyse von Claude · ${esc(selectionLabel())}</strong>
      <button class="mr-ai-close" ${onClick('mrCloseAnalysis')} title="Schließen">✕</button>
    </div>
    <div class="mr-ai-text">${multiline(_ai.summary)}</div>
    <div class="mr-ai-actions">
      <button class="btn-plan-primary mr-ai-btn" ${onClick('mrAcceptSummary')}>Als Zusammenfassung übernehmen</button>
      ${n ? `<button class="btn-sm mr-ai-btn" ${onClick('mrAcceptAllComments')}>Alle ${n} Kommentarvorschläge übernehmen</button>` : ''}
      <span class="mr-ai-hint">${n ? 'Vorschläge erscheinen auch einzeln in der Kommentarspalte.' : 'Keine Kommentarvorschläge.'} Bitte vor dem Versand prüfen.</span>
    </div>
  </section>`;
}

// ── Render ────────────────────────────────────────────────────────────

function renderEmpty(msg) {
  const el = document.getElementById('mr-content');
  if (el) el.innerHTML = `<div class="plan-empty">${esc(msg)}</div>`;
}

function renderPicker() {
  const withData = monthsWithData(_year);
  const chips = MONTH_SHORT.map((name, i) => {
    const m = i + 1;
    const on = _months.includes(m);
    return `<button class="mr-chip${on ? ' on' : ''}${withData.has(m) ? '' : ' nodata'}"
      aria-pressed="${on}" ${onClick('mrToggleMonth', m)}>${name}</button>`;
  }).join('');
  const presets = ['Q1', 'Q2', 'Q3', 'Q4', 'H1', 'H2', 'YTD', 'ALL'].map(p =>
    `<button class="mr-preset" ${onClick('mrPreset', p)}>${p === 'ALL' ? 'Alle' : p}</button>`
  ).join('');
  return `<div class="mr-picker">
    <span class="mr-picker-label">Monate</span>
    <div class="mr-chips">${chips}</div>
    <div class="mr-presets">${presets}</div>
  </div>`;
}

function render() {
  const el = document.getElementById('mr-content');
  if (!el || !_year || !_months.length) return;

  if (!APP.allTransactions.some(t => t.wjYear === _year)) {
    renderEmpty(`Keine Buchungsdaten für ${_year}.`);
    return;
  }

  _rows = buildRows();
  const suggestions = _ai?.status === 'done' ? _ai.comments : {};
  const many = _months.length > 6;
  const numW = many ? 74 : 88;
  const minW = 210 + numW * (_months.length + 1) + 260;

  const head = `
    <tr>
      <th class="mr-th-pos">Position</th>
      <th class="mr-th-num mr-th-ytd">${esc(ytdLabel())}</th>
      ${_months.map(m => `<th class="mr-th-num">${MONTH_SHORT[m - 1]}</th>`).join('')}
      <th class="mr-th-comment">Kommentar</th>
    </tr>`;

  const body = _rows.map(r => {
    const s = suggestions[r.key];
    return `
      <tr class="mr-row mr-${r.style}">
        <td class="mr-pos">${esc(r.label)}</td>
        <td class="mr-num mr-ytd${negCls(r.ytd, r.style)}">${fmtVal(r.ytd, r.style)}</td>
        ${_months.map(m => `<td class="mr-num${negCls(r.months[m], r.style)}">${fmtVal(r.months[m], r.style)}</td>`).join('')}
        <td class="mr-comment">
          <textarea class="mr-comment-input" rows="1" placeholder="Kommentar…"
            ${onInput('mrCommentInput', r.key, '@this')}>${esc(_notes.comments[r.key] || '')}</textarea>
          ${s ? `<div class="mr-suggest">
            <span class="mr-suggest-text">✨ ${esc(s)}</span>
            <button class="mr-suggest-btn" ${onClick('mrAcceptComment', r.key)}>Übernehmen</button>
          </div>` : ''}
        </td>
      </tr>`;
  }).join('');

  const analyzeBtn = document.getElementById('mr-analyze-btn');
  if (analyzeBtn) analyzeBtn.disabled = _ai?.status === 'loading';

  el.innerHTML = `
    <div class="mr-wrap">
      ${renderPicker()}
      ${renderAiPanel()}
      <section class="mr-summary">
        <label class="mr-summary-label" for="mr-summary">Zusammenfassung · ${esc(selectionLabel())}</label>
        <textarea id="mr-summary" class="mr-summary-input" rows="3"
          placeholder="Executive Summary: wichtigste Entwicklungen, Abweichungen, Ausblick…"
          ${onInput('mrSummaryInput', '@this')}>${esc(_notes.summary)}</textarea>
      </section>
      <div class="mr-table-scroll">
        <table class="mr-table${many ? ' mr-many' : ''}" style="min-width:${minW}px">
          <colgroup>
            <col style="width:210px">
            ${`<col style="width:${numW}px">`.repeat(_months.length + 1)}
            <col>
          </colgroup>
          <thead>${head}</thead>
          <tbody>${body}</tbody>
        </table>
      </div>
      <div class="mr-foot">Alle Beträge in EUR · Aufwand negativ dargestellt · Kommentare werden automatisch gespeichert und gelten für die gewählte Monatsauswahl</div>
    </div>`;

  el.querySelectorAll('textarea').forEach(autoGrow);
}

// ── PDF export ────────────────────────────────────────────────────────

export async function mrExportPrint() {
  if (!_rows.length) { showToast('Kein Report zum Exportieren.'); return; }
  await flushSave();

  const n = _months.length;
  const landscape = n > 2;
  const fs = n <= 3 ? 8.5 : n <= 6 ? 7.5 : 6.3;
  const posPct = n <= 2 ? 32 : n <= 6 ? 22 : 15;
  const numPct = n <= 2 ? 12 : n <= 6 ? 8 : 5.4;

  const companyName = (APP.loadedFiles || []).map(f => f.companyName).filter(Boolean).join(', ');
  const exportDate = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

  const body = _rows.map(r => `
      <tr class="r-${r.style}">
        <td class="pos">${esc(r.label)}</td>
        <td class="num ytd${negCls(r.ytd, r.style)}">${fmtVal(r.ytd, r.style)}</td>
        ${_months.map(m => `<td class="num${negCls(r.months[m], r.style)}">${fmtVal(r.months[m], r.style)}</td>`).join('')}
        <td class="cmt">${multiline(_notes.comments[r.key] || '')}</td>
      </tr>`).join('');

  const html = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>Management Report ${esc(selectionLabel())}${companyName ? ' · ' + esc(companyName) : ''}</title>
<style>
  @page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: 12mm 10mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: ${fs}pt; color: #1e2433; }
  .header { display: flex; justify-content: space-between; align-items: flex-start;
            border-bottom: 2px solid #1e2433; padding-bottom: 3mm; margin-bottom: 5mm; }
  .header h1 { font-size: 15pt; font-weight: 700; }
  .header .sub { font-size: 9pt; color: #4b5563; margin-top: 3px; }
  .header .meta { font-size: 7.5pt; color: #6b7280; text-align: right; line-height: 1.6; }
  .summary { background: #f4f6fb; border-left: 3px solid #4f6ef7; padding: 3mm 4mm; margin-bottom: 6mm; }
  .summary h2 { font-size: 9pt; text-transform: uppercase; letter-spacing: .05em; color: #4f6ef7; margin-bottom: 2mm; }
  .summary p { font-size: 9pt; line-height: 1.5; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th { background: #1e2433; color: #fff; font-size: ${fs - 0.8}pt; font-weight: 600; padding: 4px 5px; text-align: right; white-space: nowrap; }
  th.pos, th.cmt { text-align: left; }
  th.ytd { background: #2d3a5a; }
  td { padding: 3px 5px; border-bottom: 1px solid #e8ebf2; vertical-align: top; }
  tr { page-break-inside: avoid; }
  td.pos { text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  td.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  td.num.neg { color: #b42318; }
  td.ytd { background: #f2f4fa; font-weight: 600; }
  td.cmt { color: #374151; line-height: 1.4; }
  .r-section td { font-weight: 700; background: #f4f6fb; }
  .r-section td.ytd { background: #e9edf6; }
  .r-sub td.pos { padding-left: 14px; color: #4b5563; }
  .r-computed td { font-weight: 700; background: #eef1ff; border-top: 1px solid #c8d3ef; }
  .r-final td { font-weight: 700; background: #dfe6fb; border-top: 2px solid #b7c5ec; border-bottom: 2px solid #b7c5ec; }
  .r-ratio td { font-style: italic; color: #4f6ef7; }
  .foot { margin-top: 4mm; font-size: 7pt; color: #6b7280; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style>
</head>
<body>
<div class="header">
  <div>
    <h1>Management Report</h1>
    <div class="sub">${esc(selectionLabel())}${companyName ? ' · ' + esc(companyName) : ''}</div>
  </div>
  <div class="meta">Erstellt am ${exportDate}<br>Alle Beträge in EUR</div>
</div>
${_notes.summary.trim() ? `<div class="summary"><h2>Zusammenfassung</h2><p>${multiline(_notes.summary)}</p></div>` : ''}
<table>
  <colgroup>
    <col style="width:${posPct}%">
    ${`<col style="width:${numPct}%">`.repeat(n + 1)}
    <col>
  </colgroup>
  <thead>
    <tr>
      <th class="pos">Position</th>
      <th class="ytd">${esc(ytdLabel())}</th>
      ${_months.map(m => `<th>${MONTH_SHORT[m - 1]}</th>`).join('')}
      <th class="cmt">Kommentar</th>
    </tr>
  </thead>
  <tbody>${body}</tbody>
</table>
<div class="foot">Aufwand negativ dargestellt.</div>
</body>
</html>`;

  const w = window.open('', '_blank', landscape ? 'width=1200,height=850' : 'width=900,height=1000');
  if (!w) { showToast('Popup blockiert — bitte Popups für diese Seite erlauben.'); return; }
  w.document.write(html);
  w.document.close();
  w.onload = () => w.print();
}
