export function parseDE(s) {
  s = String(s || '').trim();
  if (!s) return 0;
  try { return parseFloat(s.replace(/\./g, '').replace(',', '.')) || 0; }
  catch { return 0; }
}

export function parseDateDE(s) {
  s = String(s || '').trim();
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  return null;
}

export function parseStapel(s) {
  const m = String(s || '').match(/^(\d{2})-(\d{4})/);
  if (m) return { month: +m[1], year: +m[2] };
  return null;
}

export function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

export function fmtK(n) {
  if (n === 0) return '—';
  const abs = Math.abs(n), neg = n < 0;
  let s;
  if (abs >= 1e6) s = (abs / 1e6).toFixed(2).replace('.', ',') + ' M';
  else if (abs >= 1000) s = Math.round(abs / 1000).toLocaleString('de-DE') + 'k';
  else s = Math.round(abs).toLocaleString('de-DE');
  return (neg ? '−' : '') + s;
}

const FMTFULL = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function fmtFull(n) {
  return FMTFULL.format(n);
}

export const MONTH_SHORT = ['Jan','Feb','Mrz','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
