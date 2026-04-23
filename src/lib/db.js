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

export async function loadMetaFromServer() {
  const res = await apiFetch('/api/data/meta');
  if (!res.ok) throw new Error('Meta load failed: ' + res.status);
  const data = await res.json();
  if (!data) return null;
  return {
    loadedFiles:  data.loadedFiles,
    accountNames: new Map(data.accountNames),
  };
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

// ── Planning API ──────────────────────────────────────────────────────

export async function getPlanVersions(year) {
  const url = year ? `/api/plan/versions?year=${encodeURIComponent(year)}` : '/api/plan/versions';
  const res = await apiFetch(url);
  if (!res.ok) throw new Error((await res.json()).error);
  return res.json();
}

export async function getPlanVersion(id) {
  const res = await apiFetch(`/api/plan/versions/${id}`);
  if (!res.ok) throw new Error((await res.json()).error);
  return res.json();
}

export async function createPlanVersion(name, year, type, notes) {
  const res = await apiFetch('/api/plan/versions', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name, year, type, notes }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

export async function updatePlanVersion(id, patch) {
  const res = await apiFetch(`/api/plan/versions/${id}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

export async function lockPlanVersion(id, locked) {
  const res = await apiFetch(`/api/plan/versions/${id}/lock`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ locked }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

export async function deletePlanVersion(id) {
  const res = await apiFetch(`/api/plan/versions/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error((await res.json()).error);
}

export async function getPlanEntries(versionId, itemId) {
  const url = `/api/plan/versions/${versionId}/entries${itemId ? `?item_id=${encodeURIComponent(itemId)}` : ''}`;
  const res = await apiFetch(url);
  if (!res.ok) throw new Error((await res.json()).error);
  return res.json();
}

export async function upsertPlanEntries(versionId, entries) {
  const res = await apiFetch(`/api/plan/versions/${versionId}/entries`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ entries }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

export async function getPlanAssumptions(versionId) {
  const res = await apiFetch(`/api/plan/versions/${versionId}/assumptions`);
  if (!res.ok) throw new Error((await res.json()).error);
  return res.json();
}

// ── Planning: line items ──────────────────────────────────────────────

export async function getPlanLineItems(versionId, { category, activeOnly = true } = {}) {
  const params = new URLSearchParams({ ...(category ? { category } : {}), active_only: String(activeOnly) });
  const res = await apiFetch(`/api/plan/versions/${versionId}/line-items?${params}`);
  if (!res.ok) throw new Error((await res.json()).error);
  return res.json();
}

export async function createPlanLineItem(versionId, data) {
  const res = await apiFetch(`/api/plan/versions/${versionId}/line-items`, {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(data),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error);
  return json;
}

export async function updatePlanLineItem(versionId, lineItemId, patch) {
  const res = await apiFetch(`/api/plan/versions/${versionId}/line-items/${lineItemId}`, {
    method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(patch),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error);
  return json;
}

export async function deletePlanLineItem(versionId, lineItemId) {
  const res = await apiFetch(`/api/plan/versions/${versionId}/line-items/${lineItemId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error((await res.json()).error);
}

export async function getLineItemEntries(versionId, lineItemId) {
  const res = await apiFetch(`/api/plan/versions/${versionId}/line-items/${lineItemId}/entries`);
  if (!res.ok) throw new Error((await res.json()).error);
  return res.json();
}

export async function upsertLineItemEntries(versionId, lineItemId, entries) {
  const res = await apiFetch(`/api/plan/versions/${versionId}/line-items/${lineItemId}/entries`, {
    method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ entries }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error);
  return json;
}

export async function savePlanAssumptions(versionId, assumptions) {
  const res = await apiFetch(`/api/plan/versions/${versionId}/assumptions`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ assumptions }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

// ── Planning: revenue drivers ─────────────────────────────────────────

export async function getRevenueDrivers(lineItemId) {
  const res = await apiFetch(`/api/plan/line-items/${lineItemId}/drivers`);
  if (!res.ok) throw new Error((await res.json()).error);
  return res.json();
}

export async function createRevenueDriver(lineItemId, data) {
  const res = await apiFetch(`/api/plan/line-items/${lineItemId}/drivers`, {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(data),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error);
  return json;
}

export async function updateRevenueDriver(lineItemId, driverId, patch) {
  const res = await apiFetch(`/api/plan/line-items/${lineItemId}/drivers/${driverId}`, {
    method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(patch),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error);
  return json;
}

export async function deleteRevenueDriver(lineItemId, driverId) {
  const res = await apiFetch(`/api/plan/line-items/${lineItemId}/drivers/${driverId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error((await res.json()).error);
}

export async function generateFromDrivers(lineItemId, dryRun = false) {
  const url = `/api/plan/line-items/${lineItemId}/generate${dryRun ? '?dry_run=true' : ''}`;
  const res = await apiFetch(url, { method: 'POST' });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error);
  return json;
}

// ── Planning: personnel drivers ───────────────────────────────────────

export async function getPersonnelDrivers(lineItemId) {
  const res = await apiFetch(`/api/plan/line-items/${lineItemId}/personnel`);
  if (!res.ok) throw new Error((await res.json()).error);
  return res.json();
}

export async function createPersonnelDriver(lineItemId, data) {
  const res = await apiFetch(`/api/plan/line-items/${lineItemId}/personnel`, {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(data),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error);
  return json;
}

export async function updatePersonnelDriver(lineItemId, driverId, patch) {
  const res = await apiFetch(`/api/plan/line-items/${lineItemId}/personnel/${driverId}`, {
    method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(patch),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error);
  return json;
}

export async function deletePersonnelDriver(lineItemId, driverId) {
  const res = await apiFetch(`/api/plan/line-items/${lineItemId}/personnel/${driverId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error((await res.json()).error);
}

// ── Cost Allocation API ───────────────────────────────────────────────

export async function getAllocationRules(versionId) {
  const res = await apiFetch(`/api/plan/versions/${versionId}/allocation-rules`);
  if (!res.ok) throw new Error((await res.json()).error);
  return res.json();
}

export async function getAllocationRule(id) {
  const res = await apiFetch(`/api/plan/allocation-rules/${id}`);
  if (!res.ok) throw new Error((await res.json()).error);
  return res.json();
}

export async function createAllocationRule(versionId, data) {
  const res = await apiFetch(`/api/plan/versions/${versionId}/allocation-rules`, {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(data),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error);
  return json;
}

export async function updateAllocationRule(id, patch) {
  const res = await apiFetch(`/api/plan/allocation-rules/${id}`, {
    method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(patch),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error);
  return json;
}

export async function deleteAllocationRule(id) {
  const res = await apiFetch(`/api/plan/allocation-rules/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error((await res.json()).error);
}

export async function setAllocationTargets(ruleId, targets) {
  const res = await apiFetch(`/api/plan/allocation-rules/${ruleId}/targets`, {
    method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ targets }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error);
  return json;
}

export async function generateAllocation(ruleId, dryRun = false) {
  const url = `/api/plan/allocation-rules/${ruleId}/generate${dryRun ? '?dry_run=true' : ''}`;
  const res = await apiFetch(url, { method: 'POST' });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error);
  return json;
}

export async function saveManualAllocation(ruleId, targetId, amounts) {
  const res = await apiFetch(`/api/plan/allocation-rules/${ruleId}/targets/${targetId}/manual`, {
    method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ amounts }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error);
  return json;
}

export async function getAllocationResults(ruleId) {
  const res = await apiFetch(`/api/plan/allocation-rules/${ruleId}/results`);
  if (!res.ok) throw new Error((await res.json()).error);
  return res.json();
}

export async function generateOpexEntries(lineItemId, dryRun = false) {
  const url = `/api/plan/line-items/${lineItemId}/generate-opex${dryRun ? '?dry_run=true' : ''}`;
  const res = await apiFetch(url, { method: 'POST' });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error);
  return json;
}

export async function generatePersonnelEntries(lineItemId, dryRun = false) {
  const url = `/api/plan/line-items/${lineItemId}/generate-personnel${dryRun ? '?dry_run=true' : ''}`;
  const res = await apiFetch(url, { method: 'POST' });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error);
  return json;
}
