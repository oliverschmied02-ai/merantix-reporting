/**
 * Server-side persistence via /api/data.
 * Data is stored as JSON on the Railway server (persistent volume).
 * Works across all devices and browsers.
 */

export async function saveToServer(transactions, loadedFiles, accountNames) {
  const payload = {
    transactions: transactions.map(t => ({
      ...t,
      datum: t.datum ? t.datum.toISOString() : null,
    })),
    loadedFiles,
    accountNames: [...accountNames.entries()],
  };
  const res = await fetch('/api/data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('Save failed: ' + res.status);
}

export async function loadFromServer() {
  const res = await fetch('/api/data');
  if (!res.ok) return null;
  const data = await res.json();
  if (!data) return null;

  return {
    transactions: data.transactions.map(t => ({
      ...t,
      datum: t.datum ? new Date(t.datum) : null,
    })),
    loadedFiles:  data.loadedFiles || [],
    accountNames: new Map(data.accountNames || []),
  };
}

export async function clearFromServer() {
  await fetch('/api/data', { method: 'DELETE' });
}
