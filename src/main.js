import './styles/main.css';
import { loadAppState, loadKpiOrder } from './lib/storage.js';
import { APP, resetAPP } from './state.js';
import { setScreen, setMainView, setLoading, showToast, updateAboveTableHeight } from './ui/screen.js';
import { buildPL, toggleSection, toggleSub, setViewMode } from './ui/pl-table.js';
import { openDrill, renderDrillTable, closeDrill } from './ui/drill.js';
import { toggleSettings, switchSettingsTab, renderCoATree,
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
import { checkAuth, login, logout, loadFromServer, clearFromServer, getUsers, createUser, deleteUser } from './lib/db.js';
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

async function renderUsersList() {
  const container = document.getElementById('users-list');
  if (!container) return;
  try {
    const users = await getUsers();
    container.innerHTML = `
      <div style="font-size:.8rem;font-weight:600;color:#1e2433;margin-bottom:.6rem">Aktive Benutzer (${users.length})</div>
      ${users.map(u => `
        <div style="display:flex;align-items:center;gap:.75rem;padding:.5rem .6rem;background:#f8f9fd;border-radius:8px;margin-bottom:.35rem">
          <div style="flex:1">
            <div style="font-size:.8rem;font-weight:600;color:#1e2433">${u.name}</div>
            <div style="font-size:.7rem;color:#8b95a9">${u.email}</div>
          </div>
          <button onclick="removeUser(${u.id})" style="padding:.25rem .55rem;background:#fff;color:#dc2626;border:1px solid #fecaca;border-radius:6px;font-size:.7rem;cursor:pointer;font-family:inherit">✕</button>
        </div>`).join('')}`;
  } catch {}
}

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

// Wire up users tab render when opened
const _origSwitchTab = window.switchSettingsTab;
window.switchSettingsTab = function(tab) {
  _origSwitchTab(tab);
  if (tab === 'users') renderUsersList();
};

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

  setScreen('upload-screen');
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
    else if (document.getElementById('settings-panel').classList.contains('open')) toggleSettings(false);
  });
  document.getElementById('new-section-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('new-section-modal')) closeNewSectionModal();
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
