import './styles/main.css';
import { loadAppState } from './lib/storage.js';
import { loadKpiOrder } from './lib/storage.js';
import { APP, resetAPP } from './state.js';
import { deepClone } from './lib/utils.js';
import { DEFAULT_PL_DEF } from './data/default-pl.js';
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
import { handleFile, removeFile, updateSidebarBadge } from './lib/file-handler.js';
import { toggleSidebar, renderFilesScreen } from './ui/files.js';

// Expose all functions globally (called from inline onclick= in HTML)
Object.assign(window, {
  // screen
  setMainView, showToast, setLoading, updateAboveTableHeight,
  // pl-table
  buildPL, toggleSection, toggleSub, setViewMode,
  // drill
  openDrill, renderDrillTable, closeDrill,
  // settings
  toggleSettings, switchSettingsTab, renderCoATree,
  addSubDialog, toggleAcctPicker, filterAcctPicker, addAccountToSub,
  unmapAndMove, updateItemLabel, updateItemBalance, updateSubLabel,
  removeAccount, removeSub, removeItem, selectNsType, addNewSection,
  closeNewSectionModal, confirmNewSection, updateRatioFormula,
  restoreDefaultPL, exportCoA, importCoADialog, movePlDefItem,
  // rules
  initTransactionPicker, updateTransactionPicker, toggleTransactionSelection,
  toggleSelectAllTransactions, updateTransactionSelectionPanel,
  applyBulkReclassification, clearTransactionSelection,
  renderRulesList, toggleRule, deleteRule,
  // file-handler
  handleFile, removeFile, updateSidebarBadge,
  // files / sidebar
  toggleSidebar, renderFilesScreen,
  // reset
  resetAll,
});

function resetAll() {
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

function initApp() {
  loadAppState();
  APP.kpiOrder = loadKpiOrder();

  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', e => handleFile(e.target.files[0]));
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    handleFile(e.dataTransfer.files[0]);
  });

  document.getElementById('overlay').addEventListener('click', () => {
    if (document.getElementById('drill-panel').classList.contains('open')) closeDrill();
    else if (document.getElementById('settings-panel').classList.contains('open')) toggleSettings(false);
  });

  // New section modal backdrop
  document.getElementById('new-section-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('new-section-modal')) closeNewSectionModal();
  });

  initOutsidePickerClose();

  window.addEventListener('resize', updateAboveTableHeight);
}

initApp();
