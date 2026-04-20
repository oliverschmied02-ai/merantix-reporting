import './styles/main.css';
import { loadAppState, loadKpiOrder } from './lib/storage.js';
import { APP, resetAPP } from './state.js';
import { setScreen, setMainView, setLoading, showToast, updateAboveTableHeight } from './ui/screen.js';
import { buildPL, toggleSection, toggleSub, setViewMode } from './ui/pl-table.js';
import { openDrill, renderDrillTable, closeDrill } from './ui/drill.js';
import { toggleSettings, switchSettingsTab, renderCoATree, renderDataStats,
  addSubDialog, toggleAcctPicker, filterAcctPicker, addAccountToSub,
  unmapAndMove, updateItemLabel, updateItemBalance, updateSubLabel,
  removeAccount, removeSub, removeItem, selectNsType, addNewSection,
  closeNewSectionModal, confirmNewSection, updateRatioFormula,
  restoreDefaultPL, exportCoA, importCoADialog, movePlDefItem,
  initOutsidePickerClose } from './ui/settings.js';
import { initTransactionPicker, updateTransactionPicker, toggleTransactionSelection,
  toggleSelectAllTransactions, updateTransactionSelectionPanel,
  applyBulkReclassification, clearTransactionSelection,
  renderRulesList, toggleRule, deleteRule } from './ui/rules.js';
import { handleFile, removeFile, updateSidebarBadge, refreshYears, updateTopCompany } from './lib/file-handler.js';
import { toggleSidebar, renderFilesScreen } from './ui/files.js';
import { checkAuth, login, logout, loadFromServer, clearFromServer, getUsers, createUser, deleteUser, resetUserPassword, requestAccess, getAccessRequests, approveRequest, rejectRequest } from './lib/db.js';
import { rebuildAcctMap } from './lib/resolve.js';

// ── Expose globals ────────────────────────────────────────────────────
Object.assign(window, {
  setMainView, showToast, setLoading, updateAboveTableHeight,
  buildPL, toggleSection, toggleSub, setViewMode,
  openDrill, renderDrillTable, closeDrill,
  toggleSettings, switchSettingsTab, renderCoATree,
  addSubDialog, toggleAcctPicker, filterAcctPicker, addAccountToSub,
  unmapAndMove, updateItemLabel, updateItemBalance, updateSubLabel,
  removeAccount, removeSub, removeItem, selectNsType, addNewSection,
  closeNewSectionModal, confirmNewSection, updateRatioFormula,
  restoreDefaultPL, exportCoA, importCoADialog, movePlDefItem,
  initTransactionPicker, updateTransactionPicker, toggleTransactionSelection,
  toggleSelectAllTransactions, updateTransactionSelectionPanel,
  applyBulkReclassification, clearTransactionSelection,
  renderRulesList, toggleRule, deleteRule,
  handleFile, removeFile, updateSidebarBadge,
  toggleSidebar, renderFilesScreen,
  resetAll, doLogin, doLogout, addUser,
  toggleLoginPw, toggleNewUserPw,
  removeUser, startResetPw, confirmResetPw, cancelResetPw,
  openRequestAccess, closeRequestAccess, submitAccessRequest,
  approveAccessRequest, rejectAccessRequest,
  renderDataStats,
});

// ── Login ─────────────────────────────────────────────────────────────
async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const pw    = document.getElementById('login-password').value;
  const btn   = document.getElementById('login-btn');
  const err   = document.getElementById('login-error');
  err.classList.add('hidden');
  btn.disabled = true; btn.textContent = '…';
  try {
    const user = await login(email, pw);
    await loadAndShowApp(user);
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove('hidden');
  } finally {
    btn.disabled = false; btn.textContent = 'Anmelden';
  }
}
window.doLogin = doLogin;

function toggleLoginPw() {
  const inp = document.getElementById('login-password');
  inp.type = inp.type === 'password' ? 'text' : 'password';
}
window.toggleLoginPw = toggleLoginPw;

function toggleNewUserPw() {
  const inp = document.getElementById('new-user-pw');
  inp.type = inp.type === 'password' ? 'text' : 'password';
}
window.toggleNewUserPw = toggleNewUserPw;

// Enter key on login form
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.getElementById('login-screen').style.display !== 'none') doLogin();
});

// ── Logout ────────────────────────────────────────────────────────────
function doLogout() {
  logout();
  resetAPP();
  toggleSettings(false);
  showLoginScreen();
}
window.doLogout = doLogout;

function showLoginScreen() {
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('upload-screen').style.display = 'none';
  document.getElementById('loading-screen').style.display = 'none';
  document.getElementById('app-shell').style.display = 'none';
}

// ── User management ───────────────────────────────────────────────────
async function addUser() {
  const name  = document.getElementById('new-user-name').value.trim();
  const email = document.getElementById('new-user-email').value.trim();
  const pw    = document.getElementById('new-user-pw').value;
  const errEl = document.getElementById('users-error');
  errEl.textContent = '';
  try {
    await createUser(email, name, pw);
    document.getElementById('new-user-name').value = '';
    document.getElementById('new-user-email').value = '';
    document.getElementById('new-user-pw').value = '';
    renderUsersList();
  } catch (e) {
    errEl.textContent = e.message;
  }
}
window.addUser = addUser;

let _resetTargetId = null;

async function renderUsersList() {
  const container = document.getElementById('users-list');
  if (!container) return;
  try {
    const users = await getUsers();
    container.innerHTML = `
      <div style="font-size:.8rem;font-weight:600;color:#1e2433;margin-bottom:.6rem">Aktive Benutzer (${users.length})</div>
      ${users.map(u => `
        <div style="display:flex;align-items:center;gap:.5rem;padding:.5rem .6rem;background:#f8f9fd;border-radius:8px;margin-bottom:.35rem">
          <div style="flex:1">
            <div style="font-size:.8rem;font-weight:600;color:#1e2433">${u.name}</div>
            <div style="font-size:.7rem;color:#8b95a9">${u.email}</div>
          </div>
          <button onclick="startResetPw(${u.id},'${u.name}')" style="padding:.25rem .55rem;background:#fff;color:#4f6ef7;border:1px solid #d6dff5;border-radius:6px;font-size:.7rem;cursor:pointer;font-family:inherit">🔑 PW</button>
          <button onclick="removeUser(${u.id})" style="padding:.25rem .55rem;background:#fff;color:#dc2626;border:1px solid #fecaca;border-radius:6px;font-size:.7rem;cursor:pointer;font-family:inherit">✕</button>
        </div>`).join('')}`;
  } catch {}
}

function startResetPw(id, name) {
  _resetTargetId = id;
  document.getElementById('reset-pw-name').textContent = name;
  document.getElementById('reset-pw-val').value = '';
  document.getElementById('reset-pw-error').textContent = '';
  document.getElementById('reset-pw-box').style.display = 'block';
}
window.startResetPw = startResetPw;

function cancelResetPw() {
  _resetTargetId = null;
  document.getElementById('reset-pw-box').style.display = 'none';
}
window.cancelResetPw = cancelResetPw;

async function confirmResetPw() {
  const pw = document.getElementById('reset-pw-val').value;
  const errEl = document.getElementById('reset-pw-error');
  errEl.textContent = '';
  try {
    await resetUserPassword(_resetTargetId, pw);
    cancelResetPw();
    showToast('Passwort aktualisiert');
  } catch (e) {
    errEl.textContent = e.message;
  }
}
window.confirmResetPw = confirmResetPw;

async function removeUser(id) {
  if (!confirm('Benutzer löschen?')) return;
  try {
    await deleteUser(id);
    renderUsersList();
  } catch (e) {
    alert(e.message);
  }
}
window.removeUser = removeUser;

// Wire up tab render when opened
const _origSwitchTab = window.switchSettingsTab;
window.switchSettingsTab = function(tab) {
  _origSwitchTab(tab);
  if (tab === 'users') renderUsersList();
  if (tab === 'requests') renderRequestsList();
};

// ── Access requests (public) ──────────────────────────────────────────
function openRequestAccess() {
  const m = document.getElementById('access-request-modal');
  m.style.display = 'flex';
  document.getElementById('req-error').classList.add('hidden');
  document.getElementById('req-success').classList.add('hidden');
  document.getElementById('req-name').value = '';
  document.getElementById('req-email').value = '';
  document.getElementById('req-message').value = '';
}
window.openRequestAccess = openRequestAccess;

function closeRequestAccess() {
  document.getElementById('access-request-modal').style.display = 'none';
}
window.closeRequestAccess = closeRequestAccess;

async function submitAccessRequest() {
  const name    = document.getElementById('req-name').value.trim();
  const email   = document.getElementById('req-email').value.trim();
  const message = document.getElementById('req-message').value.trim();
  const errEl   = document.getElementById('req-error');
  const btn     = document.getElementById('req-btn');
  errEl.classList.add('hidden');
  if (!name || !email) { errEl.textContent = 'Name und E-Mail erforderlich.'; errEl.classList.remove('hidden'); return; }
  btn.disabled = true; btn.textContent = '…';
  try {
    await requestAccess(name, email, message);
    document.getElementById('req-success').classList.remove('hidden');
    btn.style.display = 'none';
  } catch (e) {
    errEl.textContent = e.message; errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false; if (btn.style.display !== 'none') btn.textContent = 'Anfrage senden';
  }
}
window.submitAccessRequest = submitAccessRequest;

// ── Access requests (admin) ───────────────────────────────────────────
async function renderRequestsList() {
  const container = document.getElementById('requests-list');
  const badge     = document.getElementById('requests-badge');
  if (!container) return;
  try {
    const reqs = await getAccessRequests();
    // Update badge
    if (badge) {
      badge.textContent = reqs.length;
      badge.classList.toggle('hidden', reqs.length === 0);
    }
    if (!reqs.length) {
      container.innerHTML = `<div style="text-align:center;padding:3rem 0;color:#a0aabb;font-size:.85rem">Keine offenen Anfragen</div>`;
      return;
    }
    container.innerHTML = reqs.map(r => `
      <div style="background:#fff;border:1px solid #e4e9f5;border-radius:12px;padding:1rem 1.25rem;margin-bottom:.75rem;display:flex;align-items:flex-start;gap:1rem">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;color:#1e2433;font-size:.85rem">${r.name}</div>
          <div style="color:#4f6ef7;font-size:.75rem;margin-top:.1rem">${r.email}</div>
          ${r.message ? `<div style="color:#8b95a9;font-size:.75rem;margin-top:.4rem;font-style:italic">"${r.message}"</div>` : ''}
          <div style="color:#a0aabb;font-size:.7rem;margin-top:.4rem">${new Date(r.created_at).toLocaleDateString('de-DE')}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:.35rem;flex-shrink:0">
          <button onclick="approveAccessRequest(${r.id},'${r.name}')" style="padding:.3rem .7rem;background:#4f6ef7;color:#fff;border:none;border-radius:6px;font-size:.72rem;font-weight:600;cursor:pointer;font-family:inherit">✓ Freischalten</button>
          <button onclick="rejectAccessRequest(${r.id})" style="padding:.3rem .7rem;background:#fff;color:#dc2626;border:1px solid #fecaca;border-radius:6px;font-size:.72rem;cursor:pointer;font-family:inherit">✕ Ablehnen</button>
        </div>
      </div>`).join('');
  } catch (e) {
    container.innerHTML = `<div style="color:#dc2626;font-size:.8rem">Fehler: ${e.message}</div>`;
  }
}

async function approveAccessRequest(id, name) {
  try {
    const { tempPassword } = await approveRequest(id);
    await renderRequestsList();
    await renderUsersList();
    showToast(`${name} freigeschaltet`);
    // Show temp password in a prompt-style dialog
    alert(`✓ Konto erstellt!\n\nBenutzer: ${name}\nTemporäres Passwort:\n\n${tempPassword}\n\nBitte teilen Sie dieses Passwort sicher mit dem Benutzer.`);
  } catch (e) {
    showToast('Fehler: ' + e.message);
  }
}
window.approveAccessRequest = approveAccessRequest;

async function rejectAccessRequest(id) {
  if (!confirm('Anfrage ablehnen und löschen?')) return;
  try {
    await rejectRequest(id);
    renderRequestsList();
  } catch (e) {
    showToast('Fehler: ' + e.message);
  }
}
window.rejectAccessRequest = rejectAccessRequest;

// ── Reset ─────────────────────────────────────────────────────────────
function resetAll() {
  clearFromServer().catch(() => {});
  resetAPP();
  document.getElementById('file-input').value = '';
  const ei = document.getElementById('file-input-extra');
  if (ei) ei.value = '';
  closeDrill();
  toggleSettings(false);
  setScreen('upload-screen');
}
window.resetAll = resetAll;

function handleDrop(e, source) {
  e.preventDefault();
  const dz = source === 'extra'
    ? document.getElementById('drop-zone-extra')
    : document.getElementById('drop-zone');
  if (dz) dz.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
}
window.handleDrop = handleDrop;

function handleFileInput(input) {
  if (input.files[0]) handleFile(input.files[0]);
  input.value = '';
}
window.handleFileInput = handleFileInput;

// ── Load app data and navigate to P&L ────────────────────────────────
async function loadAndShowApp(user) {
  loadAppState();
  APP.kpiOrder = loadKpiOrder();

  // Update sidebar with user name
  const logo = document.querySelector('.sb-logo-text');
  if (logo) logo.textContent = user.name;

  try {
    const saved = await loadFromServer();
    if (saved && saved.transactions.length > 0) {
      APP.allTransactions = saved.transactions;
      APP.loadedFiles     = saved.loadedFiles;
      APP.accountNames    = saved.accountNames;
      rebuildAcctMap();
      updateSidebarBadge();
      refreshYears();
      updateTopCompany();
      buildPL();
      setScreen('pl-screen');
      requestAnimationFrame(updateAboveTableHeight);
      return;
    }
  } catch (e) {
    console.warn('Could not load data:', e);
  }

  buildPL();
  setScreen('pl-screen');
  requestAnimationFrame(updateAboveTableHeight);
}

// ── App init ──────────────────────────────────────────────────────────
async function initApp() {
  // Wire up event listeners
  const dropZone  = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', e => handleFile(e.target.files[0]));
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault(); dropZone.classList.remove('drag-over');
    handleFile(e.dataTransfer.files[0]);
  });
  document.getElementById('overlay').addEventListener('click', () => {
    if (document.getElementById('drill-panel').classList.contains('open')) closeDrill();
  });
  document.getElementById('new-section-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('new-section-modal')) closeNewSectionModal();
  });
  document.getElementById('settings-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('settings-modal')) toggleSettings(false);
  });
  initOutsidePickerClose();
  window.addEventListener('resize', updateAboveTableHeight);

  // Check if already logged in
  showLoginScreen(); // default: show login
  try {
    const user = await checkAuth();
    if (user) {
      await loadAndShowApp(user);
    }
    // else: login screen stays visible
  } catch {
    // network error etc — stay on login
  }
}

initApp();
