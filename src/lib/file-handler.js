import { APP, resetAPP } from '../state.js';
import { tryDecode, parseIndexXml, parseSachkontenstamm, parseBSP } from './parser.js';
import { showToast, setScreen, setLoading } from '../ui/screen.js';
import { buildPL } from '../ui/pl-table.js';
import { renderFilesScreen } from '../ui/files.js';
import { saveFileToServer, deleteFileFromServer, clearFromServer, checkContentHash } from './db.js';

async function sha256hex(buffer) {
  const hashBuf = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function mergeTransactions(newTxns, fileId) {
  for (const t of newTxns) {
    t._fileId = fileId;
    APP.allTransactions.push(t);
  }
  return { added: newTxns.length };
}

export function refreshYears() {
  const years = new Set();
  // Derive from file metadata when available (transactions may be partial due to lazy-loading)
  if (APP.loadedFiles.length > 0) {
    for (const f of APP.loadedFiles) for (const y of (f.years || [])) years.add(y);
  } else {
    for (const t of APP.allTransactions) if (t.wjYear) years.add(t.wjYear);
  }
  APP.years = [...years].sort();
  const ySel = document.getElementById('year-sel');
  if (!ySel) return;
  const prev = ySel.value;
  ySel.innerHTML = '';
  for (const y of APP.years) {
    const opt = document.createElement('option');
    opt.value = y; opt.textContent = y;
    ySel.appendChild(opt);
  }
  if (APP.years.map(String).includes(String(prev))) ySel.value = prev;
  else if (APP.years.length) ySel.value = APP.years[APP.years.length - 1];
}

export function updateSidebarBadge() {
  const b = document.getElementById('sb-files-badge');
  if (b) b.textContent = APP.loadedFiles.length;
}

export function updateTopCompany() {
  const el = document.getElementById('top-company');
  if (!el) return;
  const names = [...new Set(APP.loadedFiles.map(f => f.companyName).filter(Boolean))];
  el.textContent =
    (names.length ? names.join(', ') + ' · ' : '') +
    APP.allTransactions.length.toLocaleString('de-DE') + ' Buchungszeilen';
}

export function removeFile(fileId) {
  // Recompute which years still have data after removing this file
  const removedFile = APP.loadedFiles.find(f => f.id === fileId);
  APP.allTransactions = APP.allTransactions.filter(t => t._fileId !== fileId);
  APP.loadedFiles = APP.loadedFiles.filter(f => f.id !== fileId);
  if (removedFile?.years) {
    const remainingYears = new Set(APP.loadedFiles.flatMap(f => f.years || []));
    for (const y of removedFile.years) {
      if (!remainingYears.has(y)) APP.loadedYears.delete(y);
    }
  }
  deleteFileFromServer(fileId).catch(e => console.warn('Delete failed:', e));
  updateSidebarBadge();
  if (APP.loadedFiles.length === 0) {
    window.resetAll();
  } else {
    refreshYears();
    updateTopCompany();
    buildPL();
    renderFilesScreen();
  }
}

export async function handleFile(file) {
  if (!file || !file.name.toLowerCase().endsWith('.zip')) {
    showToast('Bitte eine .zip-Datei auswählen.');
    return;
  }
  setLoading('ZIP wird entpackt…');
  try {
    const rawBuffer = await file.arrayBuffer();
    const contentHash = await sha256hex(rawBuffer);

    // Check for duplicate before parsing
    const dupCheck = await checkContentHash(contentHash).catch(() => ({ duplicate: false }));
    if (dupCheck.duplicate) {
      const proceed = confirm(
        `Diese Datei wurde bereits hochgeladen ("${dupCheck.file.name}").\n\nTrotzdem erneut importieren?`
      );
      if (!proceed) { if (APP.loadedFiles.length === 0) setScreen('upload-screen'); else setScreen('pl-screen'); return; }
    }

    const zip = await JSZip.loadAsync(rawBuffer);
    const fm = {};
    zip.forEach((p, e) => { fm[p.toLowerCase()] = e; });

    let indexEntry;
    for (const [k, v] of Object.entries(fm)) {
      if (k === 'index.xml' || k.endsWith('/index.xml')) { indexEntry = v; break; }
    }
    const goBack = () => APP.loadedFiles.length > 0 ? setScreen('pl-screen') : setScreen('upload-screen');
    if (!indexEntry) { showToast('index.xml nicht gefunden.'); goBack(); return; }

    setLoading('index.xml wird geparst…');
    const idxXml = tryDecode(await indexEntry.async('uint8array'));
    const tableInfo = parseIndexXml(idxXml);

    const bspInfo = tableInfo.find(t => /buchungssatzprotokoll/i.test(t.name) || /buchungssatzprotokoll/i.test(t.url));
    const skInfo  = tableInfo.find(t => /sachkont/i.test(t.name) || /sachkont/i.test(t.url));

    if (!bspInfo) { showToast('Buchungssatzprotokoll nicht gefunden.'); goBack(); return; }

    if (skInfo) {
      const ske = fm[skInfo.url.toLowerCase()] || fm[skInfo.url];
      if (ske) {
        setLoading('Sachkontenstamm…');
        parseSachkontenstamm(tryDecode(await ske.async('uint8array')), skInfo);
      }
    }

    const bspe = fm[bspInfo.url.toLowerCase()] || fm[bspInfo.url];
    if (!bspe) { showToast(bspInfo.url + ' nicht im ZIP.'); goBack(); return; }

    setLoading('Buchungen werden verarbeitet…');
    await new Promise(r => setTimeout(r, 20));
    const newTxns = parseBSP(tryDecode(await bspe.async('uint8array')), bspInfo);

    const fileId   = 'file_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    const { added } = mergeTransactions(newTxns, fileId);
    const fileYears = [...new Set(newTxns.map(t => t.wjYear).filter(Boolean))].sort();

    const fileRecord = {
      id:          fileId,
      name:        file.name,
      companyName: APP.companyName || '',
      uploadedAt:  new Date().toISOString(),
      txnCount:    added,
      years:       fileYears,
      contentHash,
    };
    APP.loadedFiles.push(fileRecord);
    // Mark these years as loaded (transactions are in memory from the parse)
    for (const y of fileYears) APP.loadedYears.add(y);

    // Save to PostgreSQL
    setLoading('Daten werden gespeichert…');
    await saveFileToServer(fileRecord, newTxns, APP.accountNames);

    updateSidebarBadge();
    refreshYears();
    updateTopCompany();
    buildPL();
    setScreen('pl-screen');
    requestAnimationFrame(() => import('../ui/screen.js').then(m => m.updateAboveTableHeight()));
  } catch (e) {
    console.error(e);
    showToast('Fehler: ' + e.message);
    if (APP.loadedFiles.length === 0) setScreen('upload-screen');
    else setScreen('pl-screen');
  }
}
