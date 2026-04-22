// Auth is handled via httpOnly session cookie — no tokens in JS/localStorage.

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const CREDS = { credentials: 'same-origin' };

async function apiFetch(url, options = {}) {
  return fetch(url, { ...CREDS, ...options });
}

export async function login(email, password) {
  const res = await apiFetch('/api/auth/login', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Login failed');
  return data.user;
}

export async function logout() {
  await apiFetch('/api/auth/logout', { method: 'POST' });
}

export async function checkAuth() {
  const res = await apiFetch('/api/auth/me');
  if (!res.ok) return null;
  const data = await res.json();
  return data.user;
}

export async function loadFromServer(year) {
  const url = year ? `/api/data?year=${encodeURIComponent(year)}` : '/api/data';
  const res = await apiFetch(url);
  if (!res.ok) throw new Error('Load failed: ' + res.status);
  const data = await res.json();
  if (!data) return null;
  return {
    loadedFiles:  data.loadedFiles,
    transactions: data.transactions.map(t => ({ ...t, datum: t.datum ? new Date(t.datum) : null })),
    accountNames: new Map(data.accountNames),
  };
}

export async function loadTransactionsForYear(year) {
  const res = await apiFetch(`/api/data?year=${encodeURIComponent(year)}`);
  if (!res.ok) throw new Error('Load failed: ' + res.status);
  const data = await res.json();
  if (!data) return [];
  return data.transactions.map(t => ({ ...t, datum: t.datum ? new Date(t.datum) : null }));
}

export async function getAuditLog(limit = 100, offset = 0) {
  const res = await apiFetch(`/api/audit?limit=${limit}&offset=${offset}`);
  if (!res.ok) throw new Error('Audit log load failed');
  return res.json();
}

export async function saveFileToServer(file, transactions, accountNames) {
  const res = await apiFetch('/api/data', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      file,
      transactions: transactions.map(t => ({ ...t, datum: t.datum ? t.datum.toISOString() : null })),
      accountNames: [...accountNames.entries()],
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Save failed');
  }
}

export async function deleteFileFromServer(fileId) {
  await apiFetch(`/api/data/${fileId}`, { method: 'DELETE' });
}

export async function clearFromServer() {
  await apiFetch('/api/data', { method: 'DELETE' });
}

export async function getUsers() {
  const res = await apiFetch('/api/users');
  return res.json();
}

export async function createUser(email, name, password) {
  const res = await apiFetch('/api/users', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, name, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

export async function changeMyPassword(password) {
  const res = await apiFetch('/api/auth/me/password', {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
}

export async function updateUserRole(id, role) {
  const res = await apiFetch(`/api/users/${id}/role`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ role }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
}

export async function resetUserPassword(id, password) {
  const res = await apiFetch(`/api/users/${id}/password`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
}

export async function saveBulkMappings(mappings) {
  const res = await apiFetch('/api/mappings', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ mappings }),
  });
  if (!res.ok) throw new Error('Save mappings failed');
}

export async function deleteMappings(txnIds) {
  await apiFetch('/api/mappings', {
    method: 'DELETE',
    headers: JSON_HEADERS,
    body: JSON.stringify({ txnIds }),
  });
}

export async function requestAccess(name, email, message) {
  const res = await apiFetch('/api/auth/request-access', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name, email, message }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
}

export async function getAccessRequests() {
  const res = await apiFetch('/api/users/requests');
  return res.json();
}

export async function approveRequest(id) {
  const res = await apiFetch(`/api/users/requests/${id}/approve`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data; // { user, tempPassword }
}

export async function rejectRequest(id) {
  await apiFetch(`/api/users/requests/${id}`, { method: 'DELETE' });
}

export async function deleteUser(id) {
  const res = await apiFetch(`/api/users/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error((await res.json()).error);
}

export async function getSetting(key) {
  const res = await apiFetch(`/api/settings/${encodeURIComponent(key)}`);
  if (!res.ok) return null;
  return res.json();
}

export async function saveSetting(key, value) {
  await apiFetch(`/api/settings/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ value }),
  });
}

export async function checkContentHash(hash) {
  const res = await apiFetch(`/api/data/check-hash/${encodeURIComponent(hash)}`);
  if (!res.ok) return { duplicate: false };
  return res.json();
}
