import { APP } from '../state.js';
import { esc } from '../lib/utils.js';

export function renderFilesScreen() {
  const container = document.getElementById('files-list');
  if (!container) return;
  if (APP.loadedFiles.length === 0) {
    container.innerHTML = '<div class="empty-state">Keine Dateien geladen</div>';
    return;
  }
  container.innerHTML = APP.loadedFiles.map(f => `
    <div class="file-card">
      <div class="file-card-icon">📄</div>
      <div class="file-card-info">
        <div class="file-card-name">${esc(f.name)}</div>
        <div class="file-card-meta">
          ${f.txnCount.toLocaleString('de-DE')} Buchungen
          · Hochgeladen: ${new Date(f.uploadedAt).toLocaleDateString('de-DE', {day:'2-digit',month:'2-digit',year:'numeric'})}
        </div>
        <div class="file-card-tags">
          ${f.years.map(y => `<span class="file-tag">📅 ${y}</span>`).join('')}
          ${f.companyName ? `<span class="file-tag">${esc(f.companyName)}</span>` : ''}
        </div>
      </div>
      <button class="file-card-remove" onclick="removeFile('${f.id}')">✕ Entfernen</button>
    </div>
  `).join('');
}

export function toggleSidebar() {
  const shell = document.getElementById('app-shell');
  shell.classList.toggle('sb-collapsed');
  const btn = document.querySelector('.sb-collapse-btn');
  if (btn) btn.textContent = shell.classList.contains('sb-collapsed') ? '▶' : '◀';
}
