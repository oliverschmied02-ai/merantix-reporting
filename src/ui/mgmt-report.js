/**
 * Management Report — P&L for a chosen period with a free-text comment next to
 * every line item, plus an executive summary. Comments auto-save (per user,
 * per year + period) and the report exports to PDF via the print dialog.
 *
 * Periods: a single month (M1–M12), a quarter (Q1–Q4) or the full year (FY).
 * Columns: the period's value and the YTD value up to the period's end
 * (for FY a single "Gesamtjahr" column).
 */

import { APP } from '../state.js';
import { esc, MONTH_SHORT } from '../lib/utils.js';
import { computePLSingle } from '../lib/compute.js';
import { getSetting, saveSetting, loadTransactionsForYear } from '../lib/db.js';
import { showToast } from './screen.js';
import { onInput } from './dispatch.js';

// ── Module state ──────────────────────────────────────────────────────

let _year    = null;
let _period  = null;               // 'M1'..'M12' | 'Q1'..'Q4' | 'FY'
let _notes   = { summary: '', comments: {} };
let _rows    = [];                 // last rendered rows (shared with PDF export)
let _saveTimer = null;
let _dirty   = false;

const SAVE_DELAY = 800;
const FMT = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

// ── Entry point ───────────────────────────────────────────────────────

export async function openReportScreen() {
  const years = [...new Set(APP.years || [])].sort((a, b) => b - a);
  if (!_year || !years.includes(_year)) {
    const plYear = parseInt(document.getElementById('year-sel')?.value);
    _year = years.includes(plYear) ? plYear : (years[0] ?? null);
  }
  populateYearSelector(years);
  if (!_year) { renderEmpty('Keine Buchungsdaten geladen. Bitte zuerst eine GDPdU-Datei importieren.'); return; }

  await ensureYearLoaded(_year);
  if (!_period) _period = `M${latestMonthWithData(_year)}`;
  populatePeriodSelector();
  await loadNotes();
  render();
}

// ── Selectors ─────────────────────────────────────────────────────────

function populateYearSelector(years) {
  const sel = document.getElementById('mr-year-sel');
  if (!sel) return;
  sel.innerHTML = years.length
    ? years.map(y => `<option value="${y}" ${y === _year ? 'selected' : ''}>${y}</option>`).join('')
    : `<option value="">—</option>`;
}

function populatePeriodSelector() {
  const sel = document.getElementById('mr-period-sel');
  if (!sel) return;
  const months = MONTH_SHORT.map((m, i) => `<option value="M${i + 1}">${m} ${_year}</option>`).join('');
  const quarters = [1, 2, 3, 4].map(q => `<option value="Q${q}">Q${q} ${_year}</option>`).join('');
  sel.innerHTML = `
    <optgroup label="Monat">${months}</optgroup>
    <optgroup label="Quartal">${quarters}</optgroup>
    <optgroup label="Jahr"><option value="FY">Gesamtjahr ${_year}</option></optgroup>`;
  sel.value = _period;
}

export async function mrChangeYear() {
  await flushSave();
  _year = parseInt(document.getElementById('mr-year-sel')?.value) || null;
  if (!_year) return;
  await ensureYearLoaded(_year);
  _period = `M${latestMonthWithData(_year)}`;
  populatePeriodSelector();
  await loadNotes();
  render();
}

export async function mrChangePeriod() {
  await flushSave();
  _period = document.getElementById('mr-period-sel')?.value || 'FY';
  await loadNotes();
  render();
}

// ── Period math ───────────────────────────────────────────────────────

function periodRange(period) {
  if (period === 'FY') return [1, 12];
  const n = parseInt(period.slice(1));
  if (period[0] === 'Q') return [n * 3 - 2, n * 3];
  return [n, n];
}

function periodLabel(period, year) {
  if (period === 'FY') return `Gesamtjahr ${year}`;
  if (period[0] === 'Q') return `${period} ${year}`;
  return `${MONTH_SHORT[parseInt(period.slice(1)) - 1]} ${year}`;
}

function ytdLabel(period) {
  const [, end] = periodRange(period);
  return end === 1 ? 'YTD Jan' : `YTD Jan–${MONTH_SHORT[end - 1]}`;
}

function latestMonthWithData(year) {
  const months = APP.allTransactions.filter(t => t.wjYear === year).map(t => t.wjMonth).filter(Boolean);
  return months.length ? Math.max(...months) : 12;
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

// ── Notes persistence (per user, per year + period) ───────────────────

const notesKey = () => `mgmt_report_v1_${_year}_${_period}`;

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
  const comments = {};
  for (const [k, v] of Object.entries(_notes.comments)) if (v && v.trim()) comments[k] = v;
  try {
    await saveSetting(notesKey(), { summary: _notes.summary, comments });
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
 * Build display rows for the current period. Values are signed for display:
 * costs negative, income positive (computed rows as calculated).
 * Each row: { key, style: 'section'|'sub'|'computed'|'final'|'ratio', label, period, ytd }
 */
function buildRows() {
  const [start, end] = periodRange(_period);
  const yearTxns = APP.allTransactions.filter(t => t.wjYear === _year);
  const pPL = computePLSingle(yearTxns.filter(t => t.wjMonth >= start && t.wjMonth <= end));
  const yPL = computePLSingle(yearTxns.filter(t => t.wjMonth >= 1 && t.wjMonth <= end));

  const hasComment = key => !!(_notes.comments[key] && _notes.comments[key].trim());
  const rows = [];

  for (const item of APP.plDef) {
    if (item.type === 'computed') {
      rows.push({
        key: item.id, style: item.level === 'final' ? 'final' : 'computed', label: item.label,
        period: pPL.computed[item.id] ?? 0, ytd: yPL.computed[item.id] ?? 0,
      });
      continue;
    }
    if (item.type === 'ratio') {
      rows.push({
        key: item.id, style: 'ratio', label: item.label,
        period: pPL.computed[item.id], ytd: yPL.computed[item.id],
      });
      continue;
    }

    const nb = item.normalBalance || 'S';
    const isMixed = item.type === 'section_mixed';
    const sectionVal = pl => isMixed ? (pl.computed[item.id] || 0)
      : (nb === 'S' ? -1 : 1) * (pl.vals[item.id]?.amount || 0);
    rows.push({
      key: item.id, style: 'section', label: item.label,
      period: sectionVal(pPL), ytd: sectionVal(yPL),
    });

    for (const sub of item.subs || []) {
      const snb = sub.normalBalance || nb;
      const subVal = pl => (snb === 'S' ? -1 : 1) * (pl.vals[item.id]?.bySubId[sub.id]?.amount || 0);
      const key = `${item.id}::${sub.id}`;
      const pv = subVal(pPL), yv = subVal(yPL);
      if (pv === 0 && yv === 0 && !hasComment(key)) continue;
      rows.push({ key, style: 'sub', label: sub.label, period: pv, ytd: yv });
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

// ── Render ────────────────────────────────────────────────────────────

function renderEmpty(msg) {
  const el = document.getElementById('mr-content');
  if (el) el.innerHTML = `<div class="plan-empty">${esc(msg)}</div>`;
}

function render() {
  const el = document.getElementById('mr-content');
  if (!el || !_year || !_period) return;

  if (!APP.allTransactions.some(t => t.wjYear === _year)) {
    renderEmpty(`Keine Buchungsdaten für ${_year}.`);
    return;
  }

  _rows = buildRows();
  const isFY = _period === 'FY';

  const head = `
    <tr>
      <th class="mr-th-pos">Position</th>
      <th class="mr-th-num">${esc(periodLabel(_period, _year))}</th>
      ${isFY ? '' : `<th class="mr-th-num mr-th-ytd">${esc(ytdLabel(_period))}</th>`}
      <th class="mr-th-comment">Kommentar</th>
    </tr>`;

  const body = _rows.map(r => {
    const neg = v => (r.style !== 'ratio' && v < 0) ? ' neg' : '';
    return `
      <tr class="mr-row mr-${r.style}">
        <td class="mr-pos">${esc(r.label)}</td>
        <td class="mr-num${neg(r.period)}">${fmtVal(r.period, r.style)}</td>
        ${isFY ? '' : `<td class="mr-num mr-ytd${neg(r.ytd)}">${fmtVal(r.ytd, r.style)}</td>`}
        <td class="mr-comment">
          <textarea class="mr-comment-input" rows="1" placeholder="Kommentar…"
            ${onInput('mrCommentInput', r.key, '@this')}>${esc(_notes.comments[r.key] || '')}</textarea>
        </td>
      </tr>`;
  }).join('');

  el.innerHTML = `
    <div class="mr-wrap">
      <section class="mr-summary">
        <label class="mr-summary-label" for="mr-summary">Zusammenfassung</label>
        <textarea id="mr-summary" class="mr-summary-input" rows="3"
          placeholder="Executive Summary: wichtigste Entwicklungen, Abweichungen, Ausblick…"
          ${onInput('mrSummaryInput', '@this')}>${esc(_notes.summary)}</textarea>
      </section>
      <table class="mr-table${isFY ? ' mr-fy' : ''}">
        <thead>${head}</thead>
        <tbody>${body}</tbody>
      </table>
      <div class="mr-foot">Alle Beträge in EUR · Aufwand negativ dargestellt · Kommentare werden automatisch gespeichert</div>
    </div>`;

  el.querySelectorAll('textarea').forEach(autoGrow);
}

// ── PDF export ────────────────────────────────────────────────────────

export async function mrExportPrint() {
  if (!_rows.length) { showToast('Kein Report zum Exportieren.'); return; }
  await flushSave();

  const isFY = _period === 'FY';
  const companyName = (APP.loadedFiles || []).map(f => f.companyName).filter(Boolean).join(', ');
  const exportDate = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const multiline = s => esc(s).replace(/\n/g, '<br>');

  const body = _rows.map(r => {
    const neg = v => (r.style !== 'ratio' && v < 0) ? ' neg' : '';
    const c = _notes.comments[r.key] || '';
    return `
      <tr class="r-${r.style}">
        <td class="pos">${esc(r.label)}</td>
        <td class="num${neg(r.period)}">${fmtVal(r.period, r.style)}</td>
        ${isFY ? '' : `<td class="num ytd${neg(r.ytd)}">${fmtVal(r.ytd, r.style)}</td>`}
        <td class="cmt">${multiline(c)}</td>
      </tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>Management Report ${esc(periodLabel(_period, _year))}${companyName ? ' · ' + esc(companyName) : ''}</title>
<style>
  @page { size: A4 portrait; margin: 14mm 12mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 8.5pt; color: #1e2433; }
  .header { display: flex; justify-content: space-between; align-items: flex-start;
            border-bottom: 2px solid #1e2433; padding-bottom: 3mm; margin-bottom: 5mm; }
  .header h1 { font-size: 15pt; font-weight: 700; }
  .header .sub { font-size: 9pt; color: #4b5563; margin-top: 3px; }
  .header .meta { font-size: 7.5pt; color: #6b7280; text-align: right; line-height: 1.6; }
  .summary { background: #f4f6fb; border-left: 3px solid #4f6ef7; padding: 3mm 4mm; margin-bottom: 6mm; }
  .summary h2 { font-size: 9pt; text-transform: uppercase; letter-spacing: .05em; color: #4f6ef7; margin-bottom: 2mm; }
  .summary p { font-size: 9pt; line-height: 1.5; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th { background: #1e2433; color: #fff; font-size: 7.5pt; font-weight: 600; padding: 4px 6px; text-align: right; }
  th.pos, th.cmt { text-align: left; }
  td { padding: 3.5px 6px; border-bottom: 1px solid #e8ebf2; vertical-align: top; }
  tr { page-break-inside: avoid; }
  td.pos { text-align: left; }
  td.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  td.num.neg { color: #b42318; }
  td.ytd { background: #f7f8fb; }
  td.cmt { font-size: 8pt; color: #374151; line-height: 1.4; }
  .r-section td { font-weight: 700; background: #f4f6fb; }
  .r-section td.ytd { background: #eef1f7; }
  .r-sub td.pos { padding-left: 16px; color: #4b5563; }
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
    <div class="sub">${esc(periodLabel(_period, _year))}${companyName ? ' · ' + esc(companyName) : ''}</div>
  </div>
  <div class="meta">Erstellt am ${exportDate}<br>Alle Beträge in EUR</div>
</div>
${_notes.summary.trim() ? `<div class="summary"><h2>Zusammenfassung</h2><p>${multiline(_notes.summary)}</p></div>` : ''}
<table>
  <colgroup>
    <col style="width:${isFY ? 36 : 32}%">
    <col style="width:${isFY ? 14 : 12}%">
    ${isFY ? '' : '<col style="width:12%">'}
    <col>
  </colgroup>
  <thead>
    <tr>
      <th class="pos">Position</th>
      <th>${esc(periodLabel(_period, _year))}</th>
      ${isFY ? '' : `<th>${esc(ytdLabel(_period))}</th>`}
      <th class="cmt">Kommentar</th>
    </tr>
  </thead>
  <tbody>${body}</tbody>
</table>
<div class="foot">Aufwand negativ dargestellt.</div>
</body>
</html>`;

  const w = window.open('', '_blank', 'width=900,height=1000');
  if (!w) { showToast('Popup blockiert — bitte Popups für diese Seite erlauben.'); return; }
  w.document.write(html);
  w.document.close();
  w.onload = () => w.print();
}
