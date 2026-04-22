import './styles/main.css';
import { loadAppState, loadKpiOrder } from './lib/storage.js';
import { APP, resetAPP } from './state.js';
import { setScreen, setMainView, setLoading, showToast, updateAboveTableHeight } from './ui/screen.js';
import { buildPL, toggleSection, toggleSub, setViewMode, exportPLCSV } from './ui/pl-table.js';
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
import { checkAuth, login, logout, loadFromServer, clearFromServer, getUsers, createUser, deleteUser, resetUserPassword, changeMyPassword, updateUserRole, requestAccess, getAccessRequests, approveRequest, rejectRequest } from './lib/db.js';
import { esc } from './lib/utils.js';
import { rebuildAcctMap } from './lib/resolve.js';

// ── Expose globals ────────────────────────────────────────────────────
Object.assign(window, {
  setMainView, showToast, setLoading, updateAboveTableHeight,
  buildPL, toggleSection, toggleSub, setViewMode, exportPLCSV,
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
  openChangePassword, closeChangePassword, submitChangePassword,
  setUserRole,
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
async function doLogout() {
  await logout().catch(() => {});
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
let _cachedUsers   = [];

async function renderUsersList() {
  const container = document.getElementById('users-list');
  if (!container) return;
  try {
    const users = await getUsers();
    _cachedUsers = users;
    const myId  = APP.currentUserId;
    container.innerHTML = `
      <div style="font-size:.82rem;font-weight:700;color:#1e2433;margin-bottom:.75rem">Aktive Benutzer (${users.length})</div>
      ${users.map(u => {
        const isMe   = u.id === myId;
        const isAdmin = u.role === 'admin';
        return `
        <div style="display:flex;align-items:center;gap:.6rem;padding:.65rem .85rem;background:#f8f9fd;border:1px solid #e4e9f5;border-radius:10px;margin-bottom:.4rem">
          <div style="flex:1;min-width:0">
            <div style="font-size:.82rem;font-weight:600;color:#1e2433">${esc(u.name)}${isMe ? ' <span style="color:#a0aabb;font-weight:400;font-size:.7rem">(du)</span>' : ''}</div>
            <div style="font-size:.72rem;color:#8b95a9">${esc(u.email)}</div>
          </div>
          <span style="padding:.15rem .55rem;border-radius:20px;font-size:.68rem;font-weight:700;background:${isAdmin ? '#eef1ff' : '#f0fdf4'};color:${isAdmin ? '#4f6ef7' : '#16a34a'}">${isAdmin ? 'Admin' : 'Viewer'}</span>
          ${!isMe ? `
          <select onchange="setUserRole(${u.id},this.value)" style="padding:.25rem .45rem;border:1px solid #d6dff5;border-radius:6px;font-size:.7rem;font-family:inherit;background:#fff;color:#1e2433;cursor:pointer">
            <option value="viewer" ${!isAdmin ? 'selected' : ''}>Viewer</option>
            <option value="admin" ${isAdmin ? 'selected' : ''}>Admin</option>
          </select>
          <button onclick="startResetPw(${u.id})" style="padding:.25rem .55rem;background:#fff;color:#4f6ef7;border:1px solid #d6dff5;border-radius:6px;font-size:.7rem;cursor:pointer;font-family:inherit">🔑 PW</button>
          <button onclick="removeUser(${u.id})" style="padding:.25rem .55rem;background:#fff;color:#dc2626;border:1px solid #fecaca;border-radius:6px;font-size:.7rem;cursor:pointer;font-family:inherit">✕</button>
          ` : ''}
        </div>`;
      }).join('')}`;
  } catch {}
}

function startResetPw(id) {
  _resetTargetId = id;
  const name = _cachedUsers.find(u => u.id === id)?.name ?? '';
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
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errEl.textContent = 'Ungültige E-Mail-Adresse.'; errEl.classList.remove('hidden'); return; }
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
          <div style="font-weight:600;color:#1e2433;font-size:.85rem">${esc(r.name)}</div>
          <div style="color:#4f6ef7;font-size:.75rem;margin-top:.1rem">${esc(r.email)}</div>
          ${r.message ? `<div style="color:#8b95a9;font-size:.75rem;margin-top:.4rem;font-style:italic">"${esc(r.message)}"</div>` : ''}
          <div style="color:#a0aabb;font-size:.7rem;margin-top:.4rem">${new Date(r.created_at).toLocaleDateString('de-DE')}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:.35rem;flex-shrink:0">
          <button onclick="approveAccessRequest(${r.id})" style="padding:.3rem .7rem;background:#4f6ef7;color:#fff;border:none;border-radius:6px;font-size:.72rem;font-weight:600;cursor:pointer;font-family:inherit">✓ Freischalten</button>
          <button onclick="rejectAccessRequest(${r.id})" style="padding:.3rem .7rem;background:#fff;color:#dc2626;border:1px solid #fecaca;border-radius:6px;font-size:.72rem;cursor:pointer;font-family:inherit">✕ Ablehnen</button>
        </div>
      </div>`).join('');
  } catch (e) {
    container.innerHTML = `<div style="color:#dc2626;font-size:.8rem">Fehler: ${e.message}</div>`;
  }
}

async function approveAccessRequest(id) {
  try {
    const { tempPassword, user } = await approveRequest(id);
    const name = user?.name ?? '';
    await renderRequestsList();
    await renderUsersList();
    showToast(`${esc(name)} freigeschaltet`);
    showTempPwModal(name, tempPassword);
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

// ── Temp password modal ───────────────────────────────────────────────
function showTempPwModal(name, password) {
  document.getElementById('temp-pw-name').textContent = name;
  document.getElementById('temp-pw-value').textContent = password;
  document.getElementById('temp-pw-copy-btn').textContent = 'Kopieren';
  document.getElementById('temp-pw-modal').style.display = 'flex';
}
function closeTempPwModal() {
  document.getElementById('temp-pw-value').textContent = '';
  document.getElementById('temp-pw-modal').style.display = 'none';
}
async function copyTempPassword() {
  const pw = document.getElementById('temp-pw-value').textContent;
  await navigator.clipboard.writeText(pw);
  const btn = document.getElementById('temp-pw-copy-btn');
  btn.textContent = '✓ Kopiert';
  setTimeout(() => { btn.textContent = 'Kopieren'; }, 2000);
}
window.closeTempPwModal = closeTempPwModal;
window.copyTempPassword = copyTempPassword;

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

// ── Role-based UI ─────────────────────────────────────────────────────
function applyRole(user) {
  const isAdmin = user.role === 'admin';
  // Nav items
  const navFiles = document.getElementById('nav-files');
  if (navFiles) navFiles.classList.toggle('hidden', !isAdmin);
  // Settings gear in top bar
  document.querySelectorAll('.btn-settings').forEach(b => b.classList.toggle('hidden', !isAdmin));
  // Settings item in sidebar footer (first button in sb-footer)
  const sbSettings = document.querySelector('.sb-footer .sb-nav-item[onclick="toggleSettings()"]');
  if (sbSettings) sbSettings.classList.toggle('hidden', !isAdmin);
  // Change-password button (shown for all)
  const cpBtn = document.getElementById('sb-change-pw');
  if (cpBtn) cpBtn.classList.remove('hidden');
  // Store role for later checks
  APP.currentUserRole = user.role;
  APP.currentUserId   = user.id;
}

// ── Change own password ───────────────────────────────────────────────
function openChangePassword() {
  document.getElementById('change-pw-modal').style.display = 'flex';
  document.getElementById('cp-old').value = '';
  document.getElementById('cp-new').value = '';
  document.getElementById('cp-confirm').value = '';
  document.getElementById('cp-error').textContent = '';
  document.getElementById('cp-error').classList.add('hidden');
}
window.openChangePassword = openChangePassword;

function closeChangePassword() {
  document.getElementById('change-pw-modal').style.display = 'none';
}
window.closeChangePassword = closeChangePassword;

async function submitChangePassword() {
  const newPw  = document.getElementById('cp-new').value;
  const conf   = document.getElementById('cp-confirm').value;
  const errEl  = document.getElementById('cp-error');
  const btn    = document.getElementById('cp-btn');
  errEl.classList.add('hidden');
  if (newPw !== conf) { errEl.textContent = 'Passwörter stimmen nicht überein.'; errEl.classList.remove('hidden'); return; }
  if (newPw.length < 6) { errEl.textContent = 'Passwort muss mindestens 6 Zeichen haben.'; errEl.classList.remove('hidden'); return; }
  btn.disabled = true; btn.textContent = '…';
  try {
    await changeMyPassword(newPw);
    closeChangePassword();
    showToast('Passwort geändert');
  } catch (e) {
    errEl.textContent = e.message; errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false; btn.textContent = 'Speichern';
  }
}
window.submitChangePassword = submitChangePassword;

// ── Role switching (admin) ────────────────────────────────────────────
async function setUserRole(id, role) {
  try {
    await updateUserRole(id, role);
    renderUsersList();
  } catch (e) {
    showToast('Fehler: ' + e.message);
  }
}
window.setUserRole = setUserRole;

// ── Load app data and navigate to P&L ────────────────────────────────
async function loadAndShowApp(user) {
  loadAppState();
  APP.kpiOrder = loadKpiOrder();

  // Update sidebar with user name
  const logo = document.querySelector('.sb-logo-text');
  if (logo) logo.textContent = user.name;

  applyRole(user);

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
