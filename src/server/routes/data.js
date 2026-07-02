import express from 'express';
import { pool } from '../db.js';
import { requireAuth, requireAdmin, logAudit } from '../middleware.js';

export const router = express.Router();

// ── USER SETTINGS (CoA / Rules persistence) ──────────────────────────
router.get('/api/settings/:key', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT value FROM user_settings WHERE user_id=$1 AND key=$2',
    [req.user.id, req.params.key]
  );
  res.json(rows.length ? rows[0].value : null);
});

router.put('/api/settings/:key', requireAuth, async (req, res) => {
  const { value } = req.body;
  if (value === undefined) return res.status(400).json({ error: 'value required' });
  await pool.query(
    `INSERT INTO user_settings (user_id, key, value, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id, key) DO UPDATE SET value=$3, updated_at=NOW()`,
    [req.user.id, req.params.key, JSON.stringify(value)]
  );
  res.json({ ok: true });
});

// ── DATA: CHECK HASH ──────────────────────────────────────────────────
router.get('/api/data/check-hash/:hash', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, name FROM gdpdu_files WHERE content_hash=$1',
    [req.params.hash]
  );
  res.json(rows.length ? { duplicate: true, file: rows[0] } : { duplicate: false });
});

// ── DATA: METADATA ONLY (no transactions) ────────────────────────────
router.get('/api/data/meta', requireAuth, async (req, res) => {
  try {
    const files = await pool.query(
      'SELECT gf.*, u.name as uploader_name FROM gdpdu_files gf LEFT JOIN users u ON gf.uploaded_by = u.id ORDER BY gf.uploaded_at'
    );
    if (files.rows.length === 0) return res.json(null);
    const accts = await pool.query('SELECT * FROM account_names');
    res.json({
      loadedFiles: files.rows.map(f => ({
        id:          f.id,
        name:        f.name,
        companyName: f.company_name || '',
        uploadedAt:  f.uploaded_at,
        txnCount:    f.txn_count,
        years:       f.years,
        uploadedBy:  f.uploader_name || '',
      })),
      accountNames: accts.rows.map(r => [r.ktonr, r.name]),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DATA: LOAD ALL (transactions, optionally filtered by year) ────────
router.get('/api/data', requireAuth, async (req, res) => {
  try {
    const files = await pool.query(
      'SELECT gf.*, u.name as uploader_name FROM gdpdu_files gf LEFT JOIN users u ON gf.uploaded_by = u.id ORDER BY gf.uploaded_at'
    );
    if (files.rows.length === 0) return res.json(null);

    // If a specific year is requested, return transactions for that year only
    const year = req.query.year ? parseInt(req.query.year) : null;
    let txnsQuery, txnsParams;
    if (year) {
      txnsQuery  = `SELECT t.*, dm.item_id AS dm_item_id, dm.sub_id AS dm_sub_id
                    FROM transactions t
                    LEFT JOIN direct_mappings dm ON dm.txn_id = t.id
                    WHERE t.wj_year = $1
                    ORDER BY t.id`;
      txnsParams = [year];
    } else {
      txnsQuery  = `SELECT t.*, dm.item_id AS dm_item_id, dm.sub_id AS dm_sub_id
                    FROM transactions t
                    LEFT JOIN direct_mappings dm ON dm.txn_id = t.id
                    ORDER BY t.id`;
      txnsParams = [];
    }
    const txns   = await pool.query(txnsQuery, txnsParams);
    const accts  = await pool.query('SELECT * FROM account_names');

    res.json({
      loadedFiles: files.rows.map(f => ({
        id:          f.id,
        name:        f.name,
        companyName: f.company_name || '',
        uploadedAt:  f.uploaded_at,
        txnCount:    f.txn_count,
        years:       f.years,
        uploadedBy:  f.uploader_name || '',
      })),
      transactions: txns.rows.map(t => ({
        _dbId:      t.id,
        ktonr:      t.ktonr,
        gktonr:     t.gktonr,
        soll:       parseFloat(t.soll),
        haben:      parseFloat(t.haben),
        datum:      t.datum ? new Date(t.datum) : null,
        text:       t.text,
        beleg:      t.beleg,
        wjMonth:    t.wj_month,
        wjYear:     t.wj_year,
        stapelRaw:  t.stapel_raw,
        _fileId:    t.file_id,
        ...(t.dm_item_id ? { _directMapping: { itemId: t.dm_item_id, subId: t.dm_sub_id } } : {}),
      })),
      accountNames: accts.rows.map(r => [r.ktonr, r.name]),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DATA: SAVE NEW FILE ───────────────────────────────────────────────
router.post('/api/data', requireAuth, async (req, res) => {
  const { file, transactions, accountNames } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO gdpdu_files (id, name, company_name, uploaded_by, uploaded_at, txn_count, years, content_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [file.id, file.name, file.companyName || null, req.user.id, file.uploadedAt, file.txnCount, JSON.stringify(file.years), file.contentHash || null]
    );

    // Batch insert transactions (500 rows per query to stay under param limits)
    const BATCH = 500;
    for (let i = 0; i < transactions.length; i += BATCH) {
      const batch = transactions.slice(i, i + BATCH);
      const vals  = batch.map((_, j) => {
        const b = j * 11;
        return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11})`;
      }).join(',');
      const params = batch.flatMap(t => [
        file.id, t.ktonr, t.gktonr ?? null, t.soll, t.haben,
        t.datum ?? null, t.text ?? null, t.beleg ?? null,
        t.wjMonth ?? null, t.wjYear ?? null, t.stapelRaw ?? null,
      ]);
      await client.query(
        `INSERT INTO transactions (file_id,ktonr,gktonr,soll,haben,datum,text,beleg,wj_month,wj_year,stapel_raw) VALUES ${vals}`,
        params
      );
    }

    // Upsert account names
    for (const [ktonr, name] of (accountNames || [])) {
      await client.query(
        'INSERT INTO account_names (ktonr, name) VALUES ($1,$2) ON CONFLICT (ktonr) DO UPDATE SET name=$2',
        [ktonr, name]
      );
    }

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── DATA: DELETE ONE FILE ─────────────────────────────────────────────
router.delete('/api/data/:fileId', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM gdpdu_files WHERE id = $1', [req.params.fileId]);
  logAudit(req.user.id, 'data.delete_file', `file_id=${req.params.fileId}`, req);
  res.json({ ok: true });
});

// ── DATA: CLEAR ALL ───────────────────────────────────────────────────
router.delete('/api/data', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM gdpdu_files'); // cascades to transactions
  await pool.query('DELETE FROM account_names');
  logAudit(req.user.id, 'data.clear_all', null, req);
  res.json({ ok: true });
});

// ── DIRECT MAPPINGS ───────────────────────────────────────────────────
router.post('/api/mappings', requireAuth, async (req, res) => {
  const { mappings } = req.body; // [{ txnId, itemId, subId }]
  if (!Array.isArray(mappings) || !mappings.length) return res.json({ ok: true });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const m of mappings) {
      await client.query(
        `INSERT INTO direct_mappings (txn_id, item_id, sub_id) VALUES ($1,$2,$3)
         ON CONFLICT (txn_id) DO UPDATE SET item_id=$2, sub_id=$3`,
        [m.txnId, m.itemId, m.subId]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

router.delete('/api/mappings', requireAuth, async (req, res) => {
  const { txnIds } = req.body;
  if (Array.isArray(txnIds) && txnIds.length) {
    await pool.query('DELETE FROM direct_mappings WHERE txn_id = ANY($1)', [txnIds]);
  } else {
    await pool.query('DELETE FROM direct_mappings');
  }
  res.json({ ok: true });
});

// ── AUDIT LOG ─────────────────────────────────────────────────────────
router.get('/api/audit', requireAuth, requireAdmin, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)  || 100, 500);
    const offset = Math.max(parseInt(req.query.offset) || 0,   0);
    const { rows } = await pool.query(
      `SELECT al.id, al.action, al.detail, al.ip, al.created_at,
              u.name AS user_name, u.email AS user_email
       FROM audit_log al
       LEFT JOIN users u ON u.id = al.user_id
       ORDER BY al.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const { rows: countRows } = await pool.query('SELECT COUNT(*) FROM audit_log');
    res.json({ rows, total: parseInt(countRows[0].count) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
