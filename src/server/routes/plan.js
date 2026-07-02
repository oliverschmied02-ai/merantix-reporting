import express from 'express';
import { pool } from '../db.js';
import { requireAuth, requireAdmin, logAudit } from '../middleware.js';

export const router = express.Router();

// ── PLANNING: VERSIONS ───────────────────────────────────────────────

// List versions, optionally filtered by year
router.get('/api/plan/versions', requireAuth, async (req, res) => {
  try {
    const year = req.query.year ? parseInt(req.query.year) : null;
    const { rows } = await pool.query(
      `SELECT pv.*,
              cb.name AS created_by_name,
              ub.name AS updated_by_name,
              lb.name AS locked_by_name,
              (SELECT COUNT(*) FROM plan_entries pe WHERE pe.version_id = pv.id) AS entry_count,
              (SELECT COUNT(*) FROM plan_assumptions pa WHERE pa.version_id = pv.id) AS assumption_count
       FROM plan_versions pv
       LEFT JOIN users cb ON cb.id = pv.created_by
       LEFT JOIN users ub ON ub.id = pv.updated_by
       LEFT JOIN users lb ON lb.id = pv.locked_by
       ${year ? 'WHERE pv.year = $1' : ''}
       ORDER BY pv.year DESC, pv.created_at DESC`,
      year ? [year] : []
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create a new version
router.post('/api/plan/versions', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, year, type = 'budget', notes } = req.body;
    if (!name || !year) return res.status(400).json({ error: 'name and year are required' });
    if (!['budget', 'forecast', 'scenario'].includes(type))
      return res.status(400).json({ error: 'type must be budget, forecast, or scenario' });
    const { rows } = await pool.query(
      `INSERT INTO plan_versions (name, year, type, notes, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $5)
       RETURNING *`,
      [name.trim(), parseInt(year), type, notes || null, req.user.id]
    );
    logAudit(req.user.id, 'plan.version.create', `id=${rows[0].id} name="${rows[0].name}" year=${rows[0].year}`, req);
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get a single version (with entries and assumptions)
router.get('/api/plan/versions/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { rows: vRows } = await pool.query(
      `SELECT pv.*, cb.name AS created_by_name, ub.name AS updated_by_name, lb.name AS locked_by_name
       FROM plan_versions pv
       LEFT JOIN users cb ON cb.id = pv.created_by
       LEFT JOIN users ub ON ub.id = pv.updated_by
       LEFT JOIN users lb ON lb.id = pv.locked_by
       WHERE pv.id = $1`, [id]
    );
    if (!vRows.length) return res.status(404).json({ error: 'Version not found' });
    const { rows: entries }     = await pool.query('SELECT * FROM plan_entries WHERE version_id=$1 ORDER BY item_id, month', [id]);
    const { rows: assumptions } = await pool.query('SELECT * FROM plan_assumptions WHERE version_id=$1 ORDER BY sort_order, id', [id]);
    res.json({ ...vRows[0], entries, assumptions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update version metadata (name, type, notes)
router.patch('/api/plan/versions/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, type, notes } = req.body;
    // Refuse writes to locked versions
    const { rows: check } = await pool.query('SELECT locked_at FROM plan_versions WHERE id=$1', [id]);
    if (!check.length) return res.status(404).json({ error: 'Version not found' });
    if (check[0].locked_at) return res.status(409).json({ error: 'Version is locked' });

    const { rows } = await pool.query(
      `UPDATE plan_versions
       SET name=$1, type=COALESCE($2,type), notes=$3, updated_by=$4, updated_at=NOW()
       WHERE id=$5 RETURNING *`,
      [name, type || null, notes ?? null, req.user.id, id]
    );
    logAudit(req.user.id, 'plan.version.update', `id=${id}`, req);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lock / unlock a version
router.post('/api/plan/versions/:id/lock', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { locked } = req.body; // true = lock, false = unlock
    const { rows } = await pool.query(
      `UPDATE plan_versions
       SET locked_at = $1, locked_by = $2, updated_by = $2, updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [locked ? new Date() : null, locked ? req.user.id : null, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Version not found' });
    logAudit(req.user.id, locked ? 'plan.version.lock' : 'plan.version.unlock', `id=${id}`, req);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete a version (cascades to entries + assumptions)
router.delete('/api/plan/versions/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { rows: check } = await pool.query('SELECT locked_at, name FROM plan_versions WHERE id=$1', [id]);
    if (!check.length) return res.status(404).json({ error: 'Version not found' });
    if (check[0].locked_at) return res.status(409).json({ error: 'Cannot delete a locked version' });
    await pool.query('DELETE FROM plan_versions WHERE id=$1', [id]);
    logAudit(req.user.id, 'plan.version.delete', `id=${id} name="${check[0].name}"`, req);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PLANNING: ENTRIES ─────────────────────────────────────────────────

// Get all entries for a version (optionally filtered by item_id)
router.get('/api/plan/versions/:id/entries', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { rows } = await pool.query(
      `SELECT pe.*, u.name AS updated_by_name
       FROM plan_entries pe
       LEFT JOIN users u ON u.id = pe.updated_by
       WHERE pe.version_id = $1
       ${req.query.item_id ? 'AND pe.item_id = $2' : ''}
       ORDER BY pe.item_id, pe.month`,
      req.query.item_id ? [id, req.query.item_id] : [id]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Bulk upsert monthly entries for a version.
// Body: { entries: [{ item_id, month, year, amount, note }] }
router.put('/api/plan/versions/:id/entries', requireAuth, requireAdmin, async (req, res) => {
  const versionId = parseInt(req.params.id);
  const { entries } = req.body;
  if (!Array.isArray(entries) || entries.length === 0)
    return res.status(400).json({ error: 'entries array required' });

  // Validate
  for (const e of entries) {
    if (!e.item_id) return res.status(400).json({ error: 'each entry needs item_id' });
    if (!e.month || e.month < 1 || e.month > 12) return res.status(400).json({ error: `invalid month: ${e.month}` });
    if (!e.year) return res.status(400).json({ error: 'each entry needs year' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Refuse writes to locked versions
    const { rows: check } = await client.query('SELECT locked_at FROM plan_versions WHERE id=$1', [versionId]);
    if (!check.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Version not found' }); }
    if (check[0].locked_at) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Version is locked' }); }

    for (const e of entries) {
      if (e.line_item_id) {
        // Line-item-scoped entry — use the partial unique index
        await client.query(
          `INSERT INTO plan_entries
             (version_id, line_item_id, item_id, month, year, amount, note, updated_by, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
           ON CONFLICT (version_id, line_item_id, month) WHERE line_item_id IS NOT NULL
           DO UPDATE SET amount=$6, note=$7, updated_by=$8, updated_at=NOW()`,
          [versionId, e.line_item_id, e.item_id, e.month, e.year, e.amount ?? 0, e.note ?? null, req.user.id]
        );
      } else {
        // Legacy entry without line_item_id — plain insert
        await client.query(
          `INSERT INTO plan_entries (version_id, item_id, month, year, amount, note, updated_by, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
           ON CONFLICT DO NOTHING`,
          [versionId, e.item_id, e.month, e.year, e.amount ?? 0, e.note ?? null, req.user.id]
        );
      }
    }
    await client.query(
      'UPDATE plan_versions SET updated_by=$1, updated_at=NOW() WHERE id=$2',
      [req.user.id, versionId]
    );
    await client.query('COMMIT');
    logAudit(req.user.id, 'plan.entries.upsert', `version_id=${versionId} count=${entries.length}`, req);
    res.json({ ok: true, count: entries.length });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── PLANNING: LINE ITEMS ──────────────────────────────────────────────

const VALID_CATEGORIES = new Set(['revenue','personnel','opex','depreciation']);

// List line items for a version, optionally filtered by category
router.get('/api/plan/versions/:id/line-items', requireAuth, async (req, res) => {
  try {
    const versionId = parseInt(req.params.id);
    const { category, active_only } = req.query;
    let where = 'WHERE pli.version_id = $1';
    const params = [versionId];
    if (category) { params.push(category); where += ` AND pli.category = $${params.length}`; }
    if (active_only !== 'false') where += ' AND pli.is_active = TRUE';
    const { rows } = await pool.query(
      `SELECT pli.*, cb.name AS created_by_name, ub.name AS updated_by_name
       FROM plan_line_items pli
       LEFT JOIN users cb ON cb.id = pli.created_by
       LEFT JOIN users ub ON ub.id = pli.updated_by
       ${where}
       ORDER BY pli.category, pli.sort_order, pli.id`,
      params
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create a line item
router.post('/api/plan/versions/:id/line-items', requireAuth, requireAdmin, async (req, res) => {
  try {
    const versionId = parseInt(req.params.id);
    const { label, item_id, category = 'other', entity, fund_ref,
            department, counterparty, notes, sort_order = 0 } = req.body;

    if (!label || !item_id) return res.status(400).json({ error: 'label and item_id are required' });
    if (!VALID_CATEGORIES.has(category))
      return res.status(400).json({ error: `category must be one of: ${[...VALID_CATEGORIES].join(', ')}` });

    const { rows: vCheck } = await pool.query('SELECT locked_at FROM plan_versions WHERE id=$1', [versionId]);
    if (!vCheck.length) return res.status(404).json({ error: 'Version not found' });
    if (vCheck[0].locked_at) return res.status(409).json({ error: 'Version is locked' });

    const { rows } = await pool.query(
      `INSERT INTO plan_line_items
         (version_id, label, item_id, category, entity, fund_ref, department,
          counterparty, notes, sort_order, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
       RETURNING *`,
      [versionId, label.trim(), item_id, category,
       entity || null, fund_ref || null, department || null,
       counterparty || null, notes || null, sort_order, req.user.id]
    );
    logAudit(req.user.id, 'plan.line_item.create', `id=${rows[0].id} label="${rows[0].label}"`, req);
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update a line item (metadata only — amounts are in plan_entries)
router.patch('/api/plan/versions/:vid/line-items/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { label, item_id, category, entity, fund_ref,
            department, counterparty, notes, sort_order, is_active } = req.body;

    if (category !== undefined && !VALID_CATEGORIES.has(category))
      return res.status(400).json({ error: `category must be one of: ${[...VALID_CATEGORIES].join(', ')}` });

    const { rows: check } = await pool.query(
      `SELECT pli.id, pv.locked_at
       FROM plan_line_items pli
       JOIN plan_versions pv ON pv.id = pli.version_id
       WHERE pli.id = $1`, [id]
    );
    if (!check.length) return res.status(404).json({ error: 'Line item not found' });
    if (check[0].locked_at) return res.status(409).json({ error: 'Version is locked' });

    const { rows } = await pool.query(
      `UPDATE plan_line_items SET
         label        = COALESCE($1,  label),
         item_id      = COALESCE($2,  item_id),
         category     = COALESCE($3,  category),
         entity       = COALESCE($4,  entity),
         fund_ref     = COALESCE($5,  fund_ref),
         department   = COALESCE($6,  department),
         counterparty = COALESCE($7,  counterparty),
         notes        = COALESCE($8,  notes),
         sort_order   = COALESCE($9,  sort_order),
         is_active    = COALESCE($10, is_active),
         updated_by   = $11,
         updated_at   = NOW()
       WHERE id = $12
       RETURNING *`,
      [label ?? null, item_id ?? null, category ?? null,
       entity ?? null, fund_ref ?? null, department ?? null,
       counterparty ?? null, notes ?? null,
       sort_order ?? null, is_active ?? null, req.user.id, id]
    );
    logAudit(req.user.id, 'plan.line_item.update', `id=${id}`, req);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Bulk upsert monthly entries for a specific line item.
// Body: { entries: [{ month, amount, note }] } — year and item_id are inferred from the line item.
router.put('/api/plan/versions/:vid/line-items/:id/entries', requireAuth, requireAdmin, async (req, res) => {
  const lineItemId = parseInt(req.params.id);
  const { entries } = req.body;
  if (!Array.isArray(entries) || entries.length === 0)
    return res.status(400).json({ error: 'entries array required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: liRows } = await client.query(
      `SELECT pli.item_id, pv.year, pv.locked_at
       FROM plan_line_items pli
       JOIN plan_versions pv ON pv.id = pli.version_id
       WHERE pli.id = $1`, [lineItemId]
    );
    if (!liRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Line item not found' }); }
    if (liRows[0].locked_at) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Version is locked' }); }

    const { item_id, year } = liRows[0];
    const versionId = parseInt(req.params.vid);

    for (const e of entries) {
      if (!e.month || e.month < 1 || e.month > 12)
        { await client.query('ROLLBACK'); return res.status(400).json({ error: `invalid month: ${e.month}` }); }
      await client.query(
        `INSERT INTO plan_entries
           (version_id, line_item_id, item_id, month, year, amount, note, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
         ON CONFLICT (version_id, line_item_id, month)
         WHERE line_item_id IS NOT NULL
         DO UPDATE SET amount=$6, note=$7, updated_by=$8, updated_at=NOW()`,
        [versionId, lineItemId, item_id, e.month, year, e.amount ?? 0, e.note ?? null, req.user.id]
      );
    }
    await client.query('COMMIT');
    logAudit(req.user.id, 'plan.line_item.entries.upsert', `line_item_id=${lineItemId} count=${entries.length}`, req);
    res.json({ ok: true, count: entries.length });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// Get entries for a single line item
router.get('/api/plan/versions/:vid/line-items/:id/entries', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM plan_entries WHERE line_item_id=$1 ORDER BY month',
      [parseInt(req.params.id)]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Soft-delete a line item (sets is_active=false, cascades nothing)
router.delete('/api/plan/versions/:vid/line-items/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { rows: check } = await pool.query(
      `SELECT pli.id, pv.locked_at FROM plan_line_items pli
       JOIN plan_versions pv ON pv.id = pli.version_id WHERE pli.id=$1`, [id]
    );
    if (!check.length) return res.status(404).json({ error: 'Line item not found' });
    if (check[0].locked_at) return res.status(409).json({ error: 'Version is locked' });
    await pool.query(
      'UPDATE plan_line_items SET is_active=FALSE, updated_by=$1, updated_at=NOW() WHERE id=$2',
      [req.user.id, id]
    );
    logAudit(req.user.id, 'plan.line_item.delete', `id=${id}`, req);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PLANNING: ASSUMPTIONS ─────────────────────────────────────────────

// Get all assumptions for a version
router.get('/api/plan/versions/:id/assumptions', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT pa.*, u.name AS updated_by_name
       FROM plan_assumptions pa
       LEFT JOIN users u ON u.id = pa.updated_by
       WHERE pa.version_id = $1
       ORDER BY pa.sort_order, pa.id`,
      [parseInt(req.params.id)]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Replace all assumptions for a version (full replace, not merge)
// Body: { assumptions: [{ label, value, note, sort_order }] }
router.put('/api/plan/versions/:id/assumptions', requireAuth, requireAdmin, async (req, res) => {
  const versionId = parseInt(req.params.id);
  const { assumptions } = req.body;
  if (!Array.isArray(assumptions)) return res.status(400).json({ error: 'assumptions array required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: check } = await client.query('SELECT locked_at FROM plan_versions WHERE id=$1', [versionId]);
    if (!check.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Version not found' }); }
    if (check[0].locked_at) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Version is locked' }); }

    await client.query('DELETE FROM plan_assumptions WHERE version_id=$1', [versionId]);
    for (let i = 0; i < assumptions.length; i++) {
      const a = assumptions[i];
      if (!a.label) continue;
      await client.query(
        `INSERT INTO plan_assumptions (version_id, label, value, note, sort_order, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [versionId, a.label, a.value ?? '', a.note ?? null, a.sort_order ?? i, req.user.id]
      );
    }
    await client.query('COMMIT');
    logAudit(req.user.id, 'plan.assumptions.update', `version_id=${versionId}`, req);
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});
