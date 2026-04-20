// All server calls include the JWT token stored in localStorage

function authHeaders() {
  const token = localStorage.getItem('gdpdu_token');
  return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

export async function login(email, password) {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Login failed');
  localStorage.setItem('gdpdu_token', data.token);
  return data.user;
}

export function logout() {
  localStorage.removeItem('gdpdu_token');
}

export async function checkAuth() {
  const token = localStorage.getItem('gdpdu_token');
  if (!token) return null;
  const res = await fetch('/api/auth/me', { headers: authHeaders() });
  if (!res.ok) { localStorage.removeItem('gdpdu_token'); return null; }
  const data = await res.json();
  return data.user;
}

export async function loadFromServer() {
  const res = await fetch('/api/data', { headers: authHeaders() });
  if (!res.ok) throw new Error('Load failed: ' + res.status);
  const data = await res.json();
  if (!data) return null;
  return {
    loadedFiles:  data.loadedFiles,
    transactions: data.transactions.map(t => ({ ...t, datum: t.datum ? new Date(t.datum) : null })),
    accountNames: new Map(data.accountNames),
  };
}

export async function saveFileToServer(file, transactions, accountNames) {
  const res = await fetch('/api/data', {
    method: 'POST',
    headers: authHeaders(),
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
  await fetch(`/api/data/${fileId}`, { method: 'DELETE', headers: authHeaders() });
}

export async function clearFromServer() {
  await fetch('/api/data', { method: 'DELETE', headers: authHeaders() });
}

export async function getUsers() {
  const res = await fetch('/api/users', { headers: authHeaders() });
  return res.json();
}

export async function createUser(email, name, password) {
  const res = await fetch('/api/users', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ email, name, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

export async function resetUserPassword(id, password) {
  const res = await fetch(`/api/users/${id}/password`, {
    method: 'PATCH',
    headers: authHeaders(),
    body: JSON.stringify({ password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
}

export async function requestAccess(name, email, message) {
  const res = await fetch('/api/auth/request-access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, message }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
}

export async function getAccessRequests() {
  const res = await fetch('/api/users/requests', { headers: authHeaders() });
  return res.json();
}

export async function approveRequest(id) {
  const res = await fetch(`/api/users/requests/${id}/approve`, { method: 'POST', headers: authHeaders() });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data; // { user, tempPassword }
}

export async function rejectRequest(id) {
  await fetch(`/api/users/requests/${id}`, { method: 'DELETE', headers: authHeaders() });
}

export async function deleteUser(id) {
  const res = await fetch(`/api/users/${id}`, { method: 'DELETE', headers: authHeaders() });
  if (!res.ok) throw new Error((await res.json()).error);
}
