/**
 * Team-wide background for the Claude analysis in the management report:
 * a free-text context plus uploaded documents (e.g. the LPA). Claude condenses
 * each document once into an editable summary; the server sends the free text
 * and the summaries with every analysis. Editing is admin-only.
 */

import { APP } from '../state.js';
import { esc } from '../lib/utils.js';
import {
  getReportContext, saveReportContext, uploadReportDocument,
  reextractReportDocument, updateReportDocument, deleteReportDocument,
} from '../lib/db.js';
import { showToast } from './screen.js';
import { onClick, onInput, onChange } from './dispatch.js';
import { confirmDialog } from './dialog.js';

let _ctx = null;               // { content, documents: [...] }
let _pollTimer = null;
const _timers = {};            // debounced saves, keyed by 'context' | doc id
const SAVE_DELAY = 800;
const MAX_BYTES = 25 * 1024 * 1024;

const PLACEHOLDER = `Hintergrund, den Claude bei jeder Analyse kennen soll, z. B.:
• Gesellschaft und verwaltete Fonds, Fondsgrößen / Commitments, Closings
• Management Fee: Satz, Bemessungsgrundlage, Zahlungsrhythmus, Step-down
• Welche Kosten der Fonds trägt und welche die Management-Gesellschaft
• Bekannte Sondereffekte im Geschäftsjahr (Umzug, Recruiting, Rechtsberatung …)
• Wünsche an Stil und Länge der Kommentare`;

const isAdmin = () => APP.currentUserRole === 'admin';
const panel = () => document.getElementById('mr-ctx-panel');

// ── Open / close ──────────────────────────────────────────────────────

export async function mrOpenContext() {
  const el = panel();
  if (!el) return;
  el.classList.remove('hidden');
  el.innerHTML = `<div class="mr-ctx-box"><div class="plan-loading">Laden…</div></div>`;
  await refresh(true);
}

export function mrCloseContext() {
  panel()?.classList.add('hidden');
}

async function refresh(full) {
  try {
    _ctx = await getReportContext();
  } catch (e) {
    showToast('Kontext konnte nicht geladen werden: ' + e.message);
    return;
  }
  if (full) renderPanel(); else renderDocs();
  schedulePoll();
}

// Poll while Claude is still summarising a document.
function schedulePoll() {
  clearTimeout(_pollTimer);
  if (!_ctx?.documents.some(d => d.status === 'pending')) return;
  _pollTimer = setTimeout(() => {
    if (panel()?.classList.contains('hidden')) return;
    refresh(false);
  }, 4000);
}

// ── Render ────────────────────────────────────────────────────────────

function renderPanel() {
  const el = panel();
  if (!el || !_ctx) return;
  const admin = isAdmin();
  el.innerHTML = `
    <div class="mr-ctx-box" role="dialog" aria-modal="true" aria-label="Kontext für die Claude-Analyse">
      <div class="mr-ctx-head">
        <div>
          <div class="mr-ctx-title">📚 Kontext für die Claude-Analyse</div>
          <div class="mr-ctx-sub">Wird bei jeder Analyse mitgeschickt und gilt für das ganze Team.${admin ? '' : ' Nur Admins können ihn bearbeiten.'}</div>
        </div>
        <button class="mr-ai-close" ${onClick('mrCloseContext')} title="Schließen">✕</button>
      </div>

      <section class="mr-ctx-section">
        <div class="mr-ctx-label">Eigener Kontext <span class="mr-ctx-status" id="mr-ctx-status-context"></span></div>
        <textarea class="mr-ctx-text" rows="9" placeholder="${esc(PLACEHOLDER)}" ${admin ? '' : 'readonly'}
          ${onInput('mrContextInput', '@this')}>${esc(_ctx.content)}</textarea>
      </section>

      <section class="mr-ctx-section">
        <div class="mr-ctx-label">Dokumente</div>
        <div class="mr-ctx-hint">PDF, TXT oder Markdown bis 25 MB, z. B. das LPA. Claude erstellt einmalig eine Zusammenfassung der für das Reporting relevanten Punkte; nur diese wird bei Analysen verwendet. Bitte prüfen und bei Bedarf anpassen.</div>
        <div id="mr-ctx-docs"></div>
        ${admin ? `
          <input type="file" id="mr-ctx-file" accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown" hidden
            ${onChange('mrUploadDoc', '@this')}>
          <button class="btn-sm mr-ctx-upload" ${onClick('clickEl', 'mr-ctx-file')}>+ Dokument hochladen</button>` : ''}
      </section>
    </div>`;
  renderDocs();
}

function fmtSize(b) {
  return b >= 1048576 ? (b / 1048576).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
}

function renderDocs() {
  const el = document.getElementById('mr-ctx-docs');
  if (!el || !_ctx) return;
  const admin = isAdmin();
  if (!_ctx.documents.length) {
    el.innerHTML = `<div class="mr-ctx-empty">Noch keine Dokumente.</div>`;
    return;
  }
  el.innerHTML = _ctx.documents.map(d => {
    const date = new Date(d.created_at).toLocaleDateString('de-DE');
    let body;
    if (d.status === 'pending') {
      body = `<div class="mr-ai-loading"><span class="mr-ai-spinner"></span>Claude wertet das Dokument aus… bei langen Dokumenten 1–3 Minuten.</div>`;
    } else if (d.status === 'error') {
      body = `<div class="mr-ctx-error">⚠ ${esc(d.error || 'Auswertung fehlgeschlagen')}</div>`;
    } else {
      body = `<textarea class="mr-ctx-text mr-ctx-doc-text" rows="8" ${admin ? '' : 'readonly'}
        ${onInput('mrDocSummaryInput', d.id, '@this')}>${esc(d.summary)}</textarea>`;
    }
    const actions = admin ? `
      <span class="mr-ctx-status" id="mr-ctx-status-${d.id}"></span>
      ${d.status !== 'pending' ? `<button class="mr-preset" ${onClick('mrReextractDoc', d.id)}>Neu auswerten</button>` : ''}
      <button class="mr-preset mr-danger" ${onClick('mrDeleteDoc', d.id)}>Löschen</button>` : '';
    return `
      <div class="mr-ctx-doc">
        <div class="mr-ctx-doc-head">
          <span class="mr-ctx-doc-name">📄 ${esc(d.filename)}</span>
          <span class="mr-ctx-doc-meta">${fmtSize(d.size_bytes)} · ${date}</span>
          <span class="mr-ctx-doc-actions">${actions}</span>
        </div>
        ${body}
      </div>`;
  }).join('');
}

function setStatus(key, state) {
  const el = document.getElementById(`mr-ctx-status-${key}`);
  if (el) el.textContent = { saving: 'Speichert…', saved: '✓ Gespeichert', error: '⚠ Fehler' }[state] ?? '';
}

function debounce(key, fn) {
  clearTimeout(_timers[key]);
  _timers[key] = setTimeout(async () => {
    setStatus(key, 'saving');
    try { await fn(); setStatus(key, 'saved'); }
    catch (e) { setStatus(key, 'error'); showToast('Speichern fehlgeschlagen: ' + e.message); }
  }, SAVE_DELAY);
}

// ── Handlers ──────────────────────────────────────────────────────────

export function mrContextInput(el) {
  if (!isAdmin() || !_ctx) return;
  _ctx.content = el.value;
  debounce('context', () => saveReportContext(_ctx.content));
}

export function mrDocSummaryInput(id, el) {
  if (!isAdmin() || !_ctx) return;
  const doc = _ctx.documents.find(d => d.id === id);
  if (doc) doc.summary = el.value;
  debounce(id, () => updateReportDocument(id, el.value));
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function mediaTypeOf(file) {
  const name = file.name.toLowerCase();
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) return 'application/pdf';
  if (name.endsWith('.md')) return 'text/markdown';
  if (file.type === 'text/plain' || name.endsWith('.txt')) return 'text/plain';
  return null;
}

export async function mrUploadDoc(input) {
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  const type = mediaTypeOf(file);
  if (!type) { showToast('Bitte eine PDF-, TXT- oder Markdown-Datei wählen. Word-Dateien bitte als PDF speichern.'); return; }
  if (file.size > MAX_BYTES) { showToast('Die Datei ist größer als 25 MB.'); return; }
  try {
    await uploadReportDocument(file.name, type, await readAsBase64(file));
    showToast('Dokument hochgeladen — Claude erstellt die Zusammenfassung.', 'success');
    await refresh(false);
  } catch (e) {
    showToast('Upload fehlgeschlagen: ' + e.message);
  }
}

export async function mrReextractDoc(id) {
  try {
    await reextractReportDocument(id);
    await refresh(false);
  } catch (e) {
    showToast('Auswertung fehlgeschlagen: ' + e.message);
  }
}

export async function mrDeleteDoc(id) {
  const doc = _ctx?.documents.find(d => d.id === id);
  if (!await confirmDialog(`„${doc?.filename ?? 'Dokument'}" und seine Zusammenfassung löschen?`, { danger: true })) return;
  try {
    await deleteReportDocument(id);
    await refresh(false);
  } catch (e) {
    showToast('Löschen fehlgeschlagen: ' + e.message);
  }
}
