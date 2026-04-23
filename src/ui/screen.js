import { renderFilesScreen } from './files.js';

export function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'error';
  t.style.display = 'block';
  setTimeout(() => (t.style.display = 'none'), 7000);
}

export function setScreen(name) {
  document.getElementById('login-screen').style.display = 'none';
  const fullScreens = ['upload-screen', 'loading-screen'];
  const shell = document.getElementById('app-shell');
  if (fullScreens.includes(name)) {
    shell.style.display = 'none';
    fullScreens.forEach(id => {
      document.getElementById(id).style.display = id === name ? 'flex' : 'none';
    });
  } else {
    fullScreens.forEach(id => { document.getElementById(id).style.display = 'none'; });
    shell.style.display = 'flex';
    ['pl-screen', 'files-screen'].forEach(id => {
      document.getElementById(id).style.display = id === name ? 'block' : 'none';
    });
    // Plan and avp screens use flex layout
    const planEl = document.getElementById('plan-screen');
    if (planEl) planEl.style.display = name === 'plan-screen' ? 'flex' : 'none';
    const avpEl = document.getElementById('avp-screen');
    if (avpEl) avpEl.style.display = name === 'avp-screen' ? 'flex' : 'none';

    document.getElementById('nav-pl').classList.toggle('active', name === 'pl-screen');
    document.getElementById('nav-files').classList.toggle('active', name === 'files-screen');
    document.getElementById('nav-plan')?.classList.toggle('active', name === 'plan-screen');
    document.getElementById('nav-avp')?.classList.toggle('active', name === 'avp-screen');
    if (name === 'files-screen') renderFilesScreen();
  }
}

export function setMainView(name) {
  setScreen(name);
}

export function setLoading(msg) {
  document.getElementById('loading-text').textContent = msg;
  setScreen('loading-screen');
}

export function updateAboveTableHeight() {
  const wrap = document.getElementById('pl-screen')?.querySelector('.pl-wrap');
  if (!wrap) return;
  const rect = wrap.getBoundingClientRect();
  if (rect.top > 0) {
    document.documentElement.style.setProperty('--above-table-h', rect.top + 'px');
  }
}
