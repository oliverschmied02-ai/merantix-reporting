/**
 * Actuals vs Plan (Ist/Plan) comparison view.
 *
 * Combines:
 *   - Actuals from APP.plData.periodPLs  (already computed by the P&L engine)
 *   - Plan entries from the API for a selected version
 *
 * Renders a table with one row per P&L category, columns grouped by month:
 *   Ist | Plan | Δ  (repeated 12×, plus annual totals)
 *
 * The existing compareVersions() function handles all variance math.
 * This module only handles data assembly + rendering.
 */

import { APP } from '../state.js';
import { esc, MONTH_SHORT } from '../lib/utils.js';
import { getPlanVersions, getPlanLineItems, getPlanEntries } from '../lib/db.js';
import { aggregateByCategory, compareVersions, COMPARE_ROWS } from '../lib/plan-compare.js';
import { extractActualsFromPeriods, extractActualsYTD } from '../lib/actuals-compare.js';
import { computePLSingle } from '../lib/compute.js';
import { showToast } from './screen.js';

// ── Module state ──────────────────────────────────────────────────────

let _versions    = [];
let _selVersion  = null;
let _selYear     = null;
let _upToMonth   = null;  // null = full year; 1-12 = YTD up to this month

// ── Entry point ───────────────────────────────────────────────────────

export async function openAvpScreen() {
  _selYear    = currentYear();
  _selVersion = null;
  _upToMonth  = latestActualMonth();

  await loadVersionList();
  populateYearSelector();
  populateMonthSelector();
  renderAvpContent();
}

// ── Data loading ──────────────────────────────────────────────────────

async function loadVersionList() {
  try {
    _versions = await getPlanVersions();
  } catch (e) {
    _versions = [];
    showToast('Planversionen konnten nicht geladen werden: ' + e.message);
  }
  populateVersionSelector();
}

// ── Selectors ─────────────────────────────────────────────────────────

function populateYearSelector() {
  const sel = document.getElementById('avp-year-sel');
  if (!sel) return;
  const years = [...new Set(APP.years || [])].sort((a, b) => b - a);
  sel.innerHTML = years.length
    ? years.map(y => `<option value="${y}" ${y === _selYear ? 'selected' : ''}>${y}</option>`).join('')
    : `<option value="">Keine Daten geladen</option>`;
}

function populateVersionSelector() {
  const sel = document.getElementById('avp-version-sel');
  if (!sel) return;
  const year = _selYear;
  const forYear = _versions
    .filter(v => !year || v.year === year)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!forYear.length) {
    sel.innerHTML = `<option value="">— Keine Planversion für ${year} —</option>`;
    _selVersion = null;
    return;
  }

  sel.innerHTML = `<option value="">— Planversion wählen —</option>` +
    forYear.map(v =>
      `<option value="${v.id}" ${v.id === _selVersion ? 'selected' : ''}>${esc(v.name)} (${TYPE_LABEL[v.type] ?? v.type})</option>`
    ).join('');

  // Auto-select first budget version for the year
  if (!_selVersion) {
    const budget = forYear.find(v => v.type === 'budget') ?? forYear[0];
    if (budget) {
      sel.value = budget.id;
      _selVersion = budget.id;
    }
  }
}

function populateMonthSelector() {
  const sel = document.getElementById('avp-month-sel');
  if (!sel) return;
  const latest = latestActualMonth();
  sel.innerHTML = `<option value="12">Gesamtjahr</option>` +
    MONTH_SHORT.map((m, i) => {
      const mo = i + 1;
      return `<option value="${mo}" ${mo === latest ? 'selected' : ''}>${m}</option>`;
    }).join('');
  sel.value = _upToMonth ?? 12;
}

// ── onChange handlers (called from HTML) ─────────────────────────────

export function avpChangeYear() {
  const sel = document.getElementById('avp-year-sel');
  _selYear = parseInt(sel?.value) || null;
  _selVersion = null;
  populateVersionSelector();
  renderAvpContent();
}

export function avpChangeVersion() {
  const sel = document.getElementById('avp-version-sel');
  _selVersion = parseInt(sel?.value) || null;
  renderAvpContent();
}

export function avpChangeMonth() {
  const sel = document.getElementById('avp-month-sel');
  const v = parseInt(sel?.value);
  _upToMonth = (!v || v >= 12) ? null : v;
  renderAvpContent();
}

// ── Main render ───────────────────────────────────────────────────────

async function renderAvpContent() {
  const el = document.getElementById('avp-content');
  if (!el) return;

  if (!_selYear) {
    el.innerHTML = `<div class="plan-empty">Kein Jahr ausgewählt. Bitte GDPdU-Datei laden.</div>`;
    return;
  }

  // Get actuals for selected year
  const allTxns = APP.allTransactions.filter(t => t.wjYear === _selYear);
  if (!allTxns.length) {
    el.innerHTML = `<div class="plan-empty">Keine Buchungsdaten für ${_selYear} geladen. Bitte zuerst eine GDPdU-Datei importieren.</div>`;
    return;
  }

  // Compute actuals per month using existing engine
  const { periodPLs } = computePeriodsForYear(_selYear);
  const actualMonthly = extractActualsFromPeriods(periodPLs);

  if (!_selVersion) {
    // Show actuals-only summary while no plan version is selected
    renderActualsOnly(el, actualMonthly, periodPLs);
    return;
  }

  el.innerHTML = `<div class="plan-loading">Plandaten laden…</div>`;

  try {
    const [lineItems, entries] = await Promise.all([
      getPlanLineItems(_selVersion, { activeOnly: false }),
      getPlanEntries(_selVersion),
    ]);

    const planMonthly = aggregateByCategory(lineItems, entries);
    const rows        = compareVersions(actualMonthly, planMonthly);
    const upTo        = _upToMonth ?? 12;

    el.innerHTML = renderTable(rows, periodPLs, upTo);
  } catch (e) {
    el.innerHTML = `<div class="plan-error">Fehler: ${esc(e.message)}</div>`;
    showToast('Fehler: ' + e.message);
  }
}

function renderActualsOnly(el, actualMonthly, periodPLs) {
  const upTo = _upToMonth ?? 12;
  const ytd  = extractActualsYTD(periodPLs, upTo);

  const rows = COMPARE_ROWS.map(row => ({
    ...row,
    ytdActual: ytd[row.key] ?? 0,
  }));

  const isEbitdaRow = r => r.computed;

  el.innerHTML = `
    <div class="avp-wrap">
      <div class="avp-no-plan-hint">
        Wähle eine Planversion um Ist/Plan-Abweichungen zu sehen.
      </div>
      <table class="avp-table avp-table-simple">
        <thead>
          <tr>
            <th class="avp-label-head">Position</th>
            <th class="avp-num-head">Ist YTD (Jan–${MONTH_SHORT[(upTo < 12 ? upTo : 12) - 1]})</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(row => `
            <tr class="${isEbitdaRow(row) ? 'avp-row-ebitda' : 'avp-row'}">
              <td class="avp-label">${esc(row.label)}</td>
              <td class="avp-num">${fmtActual(row.ytdActual)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function renderTable(rows, periodPLs, upTo) {
  const version   = _versions.find(v => v.id === _selVersion);
  const versionName = esc(version ? `${version.name} (${TYPE_LABEL[version.type] ?? version.type})` : 'Plan');
  const yearLabel   = _selYear ?? '';
  const upToLabel   = upTo < 12 ? `Jan–${MONTH_SHORT[upTo - 1]}` : 'Gesamtjahr';
  const ytdActual   = extractActualsYTD(periodPLs, upTo);

  // Build YTD plan totals
  const ytdPlan = {};
  for (const row of rows) {
    ytdPlan[row.key] = 0;
    for (let m = 1; m <= upTo; m++) {
      ytdPlan[row.key] += row.monthly[m]?.b ?? 0;
    }
  }

  // KPI summary bar (top 4: Revenue, Personnel, OpEx, EBITDA)
  const kpiKeys = ['revenue', 'personnel', 'opex', 'ebitda'];
  const kpiRows = rows.filter(r => kpiKeys.includes(r.key));

  const kpiBar = kpiRows.map(r => {
    const act  = ytdActual[r.key] ?? 0;
    const plan = ytdPlan[r.key]   ?? 0;
    const delta = act - plan;
    const pct   = plan !== 0 ? ((delta / Math.abs(plan)) * 100).toFixed(1) : null;
    const dClass = delta > 0 ? 'pos' : delta < 0 ? 'neg' : 'zero';
    // For cost items, delta > 0 means spending MORE than plan — that's bad
    const isGood = r.key === 'revenue' || r.key === 'ebitda'
      ? delta >= 0
      : delta <= 0;
    return `
      <div class="avp-kpi ${r.computed ? 'avp-kpi-ebitda' : ''}">
        <div class="avp-kpi-label">${esc(r.label)}</div>
        <div class="avp-kpi-val">${fmtActual(act)}</div>
        <div class="avp-kpi-plan">Plan: ${fmtActual(plan)}</div>
        <div class="avp-kpi-delta ${isGood ? 'good' : 'bad'}">
          ${delta >= 0 ? '+' : ''}${fmtActual(delta)}
          ${pct !== null ? `<span class="avp-kpi-pct">(${pct}%)</span>` : ''}
        </div>
      </div>`;
  }).join('');

  // Month header columns (only up to upTo)
  const visibleMonths = Array.from({ length: upTo }, (_, i) => i + 1);

  const monthHeaders = visibleMonths.map(m =>
    `<th colspan="3" class="avp-month-head">${MONTH_SHORT[m - 1]}</th>`
  ).join('') + `<th colspan="3" class="avp-annual-head">YTD ${upToLabel}</th>`;

  const subHeaders = visibleMonths.map(() =>
    `<th class="avp-sub ist">Ist</th><th class="avp-sub plan">Plan</th><th class="avp-sub delta">Δ</th>`
  ).join('') + `<th class="avp-sub ist">Ist</th><th class="avp-sub plan">Plan</th><th class="avp-sub delta">Δ</th>`;

  const bodyRows = rows.map(row => {
    const isEbitda = row.computed;
    const rowClass = isEbitda ? 'avp-row avp-row-ebitda' : 'avp-row';

    const monthlyCells = visibleMonths.map(m => {
      const cell   = row.monthly[m] ?? { a: 0, b: 0, delta: 0, pct: null };
      const ist    = cell.a;
      const plan   = cell.b;
      const delta  = cell.delta;   // plan - actual (b - a)
      // flip: we want actual - plan, so delta_istvplan = actual - plan = -cell.delta
      const ivp    = round2(ist - plan);
      const ivpCls = isEbitda
        ? (ivp >= 0 ? 'pos' : 'neg')
        : (ivp <= 0 ? 'pos' : 'neg');  // cost: under plan = good (pos colour)
      return `
        <td class="avp-cell ist">${fmtActual(ist)}</td>
        <td class="avp-cell plan">${fmtActual(plan)}</td>
        <td class="avp-cell delta avp-delta-${ivpCls}">${fmtDelta(ivp)}</td>`;
    }).join('');

    // YTD columns
    const ytdAct  = ytdActual[row.key] ?? 0;
    const ytdPl   = ytdPlan[row.key]   ?? 0;
    const ytdIvp  = round2(ytdAct - ytdPl);
    const ytdPct  = ytdPl !== 0 ? ((ytdIvp / Math.abs(ytdPl)) * 100).toFixed(1) : null;
    const ytdCls  = isEbitda ? (ytdIvp >= 0 ? 'pos' : 'neg') : (ytdIvp <= 0 ? 'pos' : 'neg');

    return `
      <tr class="${rowClass}">
        <td class="avp-label">${esc(row.label)}</td>
        ${monthlyCells}
        <td class="avp-cell ist avp-ytd">${fmtActual(ytdAct)}</td>
        <td class="avp-cell plan avp-ytd">${fmtActual(ytdPl)}</td>
        <td class="avp-cell delta avp-ytd avp-delta-${ytdCls}">
          ${fmtDelta(ytdIvp)}
          ${ytdPct !== null ? `<br><span class="avp-pct">${ytdIvp >= 0 ? '+' : ''}${ytdPct}%</span>` : ''}
        </td>
      </tr>`;
  }).join('');

  return `
    <div class="avp-wrap">
      <div class="avp-meta">
        <span class="avp-meta-year">${yearLabel}</span>
        <span class="avp-meta-sep">·</span>
        <span class="avp-meta-plan">Plan: ${versionName}</span>
        <span class="avp-meta-sep">·</span>
        <span class="avp-meta-period">Zeitraum: ${upToLabel}</span>
        <span class="avp-meta-note">Δ = Ist − Plan · grün = über Plan (Umsatz) / unter Plan (Kosten)</span>
      </div>

      <div class="avp-kpi-bar">${kpiBar}</div>

      <div class="avp-table-scroll">
        <table class="avp-table">
          <thead>
            <tr>
              <th class="avp-label-head" rowspan="2">Position</th>
              ${monthHeaders}
            </tr>
            <tr>${subHeaders}</tr>
          </thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </div>
    </div>`;
}

// ── Helpers ───────────────────────────────────────────────────────────

const TYPE_LABEL = { budget: 'Budget', forecast: 'Forecast', scenario: 'Szenario' };
const FMT = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

function fmtActual(v) {
  if (v === 0) return '<span class="avp-zero">—</span>';
  return FMT.format(Math.round(v));
}

function fmtDelta(v) {
  if (v === 0) return '<span class="avp-zero">—</span>';
  const abs = FMT.format(Math.abs(Math.round(v)));
  return v > 0 ? `+${abs}` : `−${abs}`;
}

function currentYear() {
  const sel = document.getElementById('year-sel');
  const v   = parseInt(sel?.value);
  if (v) return v;
  const years = APP.years ?? [];
  return years.length ? Math.max(...years) : null;
}

function latestActualMonth() {
  // Return the most recent month that has actual data in the current year
  const year = currentYear();
  if (!year) return 12;
  const months = [...new Set(
    APP.allTransactions.filter(t => t.wjYear === year).map(t => t.wjMonth)
  )].filter(Boolean);
  return months.length ? Math.max(...months) : 12;
}

function computePeriodsForYear(year) {
  const yearTxns = APP.allTransactions.filter(t => t.wjYear === year);
  const periodPLs = [];
  for (let m = 1; m <= 12; m++) {
    const mTxns = yearTxns.filter(t => t.wjMonth === m);
    periodPLs.push(computePLSingle(mTxns));
  }
  return { periodPLs };
}

function round2(n) { return Math.round(n * 100) / 100; }
