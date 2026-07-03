import express from 'express';
import { pool } from '../db.js';
import { requireAuth, requireAdmin, logAudit } from '../middleware.js';
import { spreadDrivers } from '../../lib/plan-revenue.js';
import { spreadPersonnelDrivers, spreadPersonnelSplit } from '../../lib/plan-personnel.js';

export const router = express.Router();

// ── PLANNING: REVENUE DRIVERS ─────────────────────────────────────────

const VALID_DRIVER_TYPES = new Set(['annual_fee', 'monthly_flat', 'one_off', 'quarterly_flat', 'management_fee']);

// List drivers for a line item
router.get('/api/plan/line-items/:liId/drivers', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT prd.*, u.name AS updated_by_name
       FROM plan_revenue_drivers prd
       LEFT JOIN users u ON u.id = prd.updated_by
       WHERE prd.line_item_id = $1
       ORDER BY prd.id`,
      [parseInt(req.params.liId)]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create a driver
router.post('/api/plan/line-items/:liId/drivers', requireAuth, requireAdmin, async (req, res) => {
  try {
    const lineItemId = parseInt(req.params.liId);
    const { driver_type = 'annual_fee', start_date, end_date,
            spread_method = 'even', notes, vendor, recurrence,
            commitment, fee_pct } = req.body;
    let { amount } = req.body;

    if (!VALID_DRIVER_TYPES.has(driver_type))
      return res.status(400).json({ error: `driver_type must be one of: ${[...VALID_DRIVER_TYPES].join(', ')}` });
    if (!['even'].includes(spread_method))
      return res.status(400).json({ error: 'spread_method must be even' });

    // management_fee: derive amount from commitment × fee_pct
    if (driver_type === 'management_fee') {
      if (commitment == null || fee_pct == null)
        return res.status(400).json({ error: 'management_fee requires commitment and fee_pct' });
      amount = Math.round(Number(commitment) * Number(fee_pct) / 100 * 100) / 100;
    } else if (amount === undefined || amount === null) {
      return res.status(400).json({ error: 'amount is required' });
    }

    // Verify the line item exists and its version isn't locked
    const { rows: liCheck } = await pool.query(
      `SELECT pli.id, pv.locked_at FROM plan_line_items pli
       JOIN plan_versions pv ON pv.id = pli.version_id
       WHERE pli.id = $1`, [lineItemId]
    );
    if (!liCheck.length) return res.status(404).json({ error: 'Line item not found' });
    if (liCheck[0].locked_at) return res.status(409).json({ error: 'Version is locked' });

    const { rows } = await pool.query(
      `INSERT INTO plan_revenue_drivers
         (line_item_id, driver_type, amount, start_date, end_date, spread_method, notes, vendor, recurrence, commitment, fee_pct, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
       RETURNING *`,
      [lineItemId, driver_type, amount, start_date || null, end_date || null,
       spread_method, notes || null, vendor || null, recurrence || null,
       commitment != null ? Number(commitment) : null,
       fee_pct    != null ? Number(fee_pct)    : null,
       req.user.id]
    );
    logAudit(req.user.id, 'plan.driver.create', `id=${rows[0].id} line_item_id=${lineItemId} type=${driver_type}`, req);
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update a driver
router.patch('/api/plan/line-items/:liId/drivers/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { driver_type, start_date, end_date, spread_method, notes, vendor, recurrence,
            commitment, fee_pct } = req.body;
    let { amount } = req.body;

    if (driver_type !== undefined && !VALID_DRIVER_TYPES.has(driver_type))
      return res.status(400).json({ error: `driver_type must be one of: ${[...VALID_DRIVER_TYPES].join(', ')}` });

    const { rows: check } = await pool.query(
      `SELECT prd.id, prd.driver_type, prd.commitment, prd.fee_pct, pv.locked_at
       FROM plan_revenue_drivers prd
       JOIN plan_line_items pli ON pli.id = prd.line_item_id
       JOIN plan_versions pv   ON pv.id  = pli.version_id
       WHERE prd.id = $1`, [id]
    );
    if (!check.length) return res.status(404).json({ error: 'Driver not found' });
    if (check[0].locked_at) return res.status(409).json({ error: 'Version is locked' });

    // Re-derive amount if this is (or is becoming) a management_fee driver
    const effectiveType = driver_type ?? check[0].driver_type;
    if (effectiveType === 'management_fee') {
      const effCommitment = commitment != null ? Number(commitment) : Number(check[0].commitment);
      const effFeePct     = fee_pct    != null ? Number(fee_pct)    : Number(check[0].fee_pct);
      amount = Math.round(effCommitment * effFeePct / 100 * 100) / 100;
    }

    const { rows } = await pool.query(
      `UPDATE plan_revenue_drivers SET
         driver_type   = COALESCE($1, driver_type),
         amount        = COALESCE($2, amount),
         start_date    = COALESCE($3, start_date),
         end_date      = COALESCE($4, end_date),
         spread_method = COALESCE($5, spread_method),
         notes         = COALESCE($6, notes),
         vendor        = COALESCE($7, vendor),
         recurrence    = COALESCE($8, recurrence),
         commitment    = COALESCE($9, commitment),
         fee_pct       = COALESCE($10, fee_pct),
         updated_by    = $11,
         updated_at    = NOW()
       WHERE id = $12 RETURNING *`,
      [driver_type ?? null, amount ?? null, start_date ?? null,
       end_date ?? null, spread_method ?? null, notes ?? null,
       vendor ?? null, recurrence ?? null,
       commitment != null ? Number(commitment) : null,
       fee_pct    != null ? Number(fee_pct)    : null,
       req.user.id, id]
    );
    logAudit(req.user.id, 'plan.driver.update', `id=${id}`, req);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete a driver
router.delete('/api/plan/line-items/:liId/drivers/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { rows: check } = await pool.query(
      `SELECT prd.id, pv.locked_at FROM plan_revenue_drivers prd
       JOIN plan_line_items pli ON pli.id = prd.line_item_id
       JOIN plan_versions pv   ON pv.id  = pli.version_id
       WHERE prd.id = $1`, [id]
    );
    if (!check.length) return res.status(404).json({ error: 'Driver not found' });
    if (check[0].locked_at) return res.status(409).json({ error: 'Version is locked' });
    await pool.query('DELETE FROM plan_revenue_drivers WHERE id=$1', [id]);
    logAudit(req.user.id, 'plan.driver.delete', `id=${id}`, req);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Generate monthly entries from all drivers on a line item.
// Skips months where is_manual_override=TRUE.
// Returns a preview when ?dry_run=true — no DB writes.
router.post('/api/plan/line-items/:liId/generate', requireAuth, requireAdmin, async (req, res) => {
  const lineItemId = parseInt(req.params.liId);
  const dryRun = req.query.dry_run === 'true';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: liRows } = await client.query(
      `SELECT pli.item_id, pv.year, pv.locked_at, pv.id AS version_id
       FROM plan_line_items pli
       JOIN plan_versions pv ON pv.id = pli.version_id
       WHERE pli.id = $1`, [lineItemId]
    );
    if (!liRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Line item not found' }); }
    if (liRows[0].locked_at) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Version is locked' }); }

    const { item_id, year, version_id } = liRows[0];

    // Load all drivers for this line item
    const { rows: drivers } = await client.query(
      'SELECT * FROM plan_revenue_drivers WHERE line_item_id=$1',
      [lineItemId]
    );

    // Load manual override flags for this line item
    const { rows: existingEntries } = await client.query(
      'SELECT month, is_manual_override FROM plan_entries WHERE version_id=$1 AND line_item_id=$2',
      [version_id, lineItemId]
    );
    const manualMonths = new Set(
      existingEntries.filter(e => e.is_manual_override).map(e => e.month)
    );

    // Spread all drivers, then filter out manual-override months
    const generated = spreadDrivers(drivers, year)
      .filter(e => !manualMonths.has(e.month));

    if (dryRun) {
      await client.query('ROLLBACK');
      return res.json({
        dry_run: true,
        year,
        generated,
        skipped_manual_months: [...manualMonths].sort(),
      });
    }

    // Clear previously generated (non-manual) entries so removed/edited
    // drivers don't leave stale months behind.
    await client.query(
      'DELETE FROM plan_entries WHERE version_id=$1 AND line_item_id=$2 AND is_manual_override=FALSE',
      [version_id, lineItemId]
    );

    // Upsert generated entries (only non-override months)
    for (const e of generated) {
      await client.query(
        `INSERT INTO plan_entries
           (version_id, line_item_id, item_id, month, year, amount, is_manual_override, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,FALSE,$7,NOW())
         ON CONFLICT (version_id, line_item_id, month)
         WHERE line_item_id IS NOT NULL
         DO UPDATE SET amount=$6, is_manual_override=FALSE, updated_by=$7, updated_at=NOW()`,
        [version_id, lineItemId, item_id, e.month, year, e.amount, req.user.id]
      );
    }

    await client.query('COMMIT');
    logAudit(req.user.id, 'plan.generate', `line_item_id=${lineItemId} generated=${generated.length} skipped_manual=${manualMonths.size}`, req);
    res.json({
      ok: true,
      generated: generated.length,
      skipped_manual_months: [...manualMonths].sort(),
    });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── PLANNING: PERSONNEL DRIVERS ──────────────────────────────────────

// List personnel drivers for a line item
router.get('/api/plan/line-items/:liId/personnel', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ppd.*, u.name AS updated_by_name
       FROM plan_personnel_drivers ppd
       LEFT JOIN users u ON u.id = ppd.updated_by
       WHERE ppd.line_item_id = $1
       ORDER BY ppd.is_filled DESC, ppd.start_date NULLS FIRST, ppd.id`,
      [parseInt(req.params.liId)]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create a personnel driver
router.post('/api/plan/line-items/:liId/personnel', requireAuth, requireAdmin, async (req, res) => {
  try {
    const lineItemId = parseInt(req.params.liId);
    const {
      employee_name, role_title, department, country, is_filled = true,
      start_date, end_date,
      annual_gross_salary, payroll_burden_rate = 0,
      salary_increase_date, annual_gross_salary_post_increase,
      annual_bonus = 0, bonus_month = 12,
      notes,
    } = req.body;

    if (!employee_name) return res.status(400).json({ error: 'employee_name is required' });
    if (annual_gross_salary === undefined || annual_gross_salary === null)
      return res.status(400).json({ error: 'annual_gross_salary is required' });
    if (bonus_month < 1 || bonus_month > 12)
      return res.status(400).json({ error: 'bonus_month must be 1–12' });
    if (payroll_burden_rate < 0)
      return res.status(400).json({ error: 'payroll_burden_rate must be >= 0' });

    const { rows: liCheck } = await pool.query(
      `SELECT pli.id, pv.locked_at FROM plan_line_items pli
       JOIN plan_versions pv ON pv.id = pli.version_id
       WHERE pli.id = $1 AND pli.category = 'personnel'`,
      [lineItemId]
    );
    if (!liCheck.length)
      return res.status(404).json({ error: 'Personnel line item not found (must have category=personnel)' });
    if (liCheck[0].locked_at) return res.status(409).json({ error: 'Version is locked' });

    const { rows } = await pool.query(
      `INSERT INTO plan_personnel_drivers
         (line_item_id, employee_name, role_title, department, country, is_filled,
          start_date, end_date, annual_gross_salary, payroll_burden_rate,
          salary_increase_date, annual_gross_salary_post_increase,
          annual_bonus, bonus_month, notes, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)
       RETURNING *`,
      [
        lineItemId, employee_name, role_title || null, department || null, country || null, is_filled,
        start_date || null, end_date || null,
        annual_gross_salary, payroll_burden_rate,
        salary_increase_date || null, annual_gross_salary_post_increase || null,
        annual_bonus, bonus_month, notes || null, req.user.id,
      ]
    );
    logAudit(req.user.id, 'plan.personnel.create',
      `id=${rows[0].id} name="${employee_name}" line_item_id=${lineItemId}`, req);
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update a personnel driver
router.patch('/api/plan/line-items/:liId/personnel/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { rows: check } = await pool.query(
      `SELECT ppd.id, pv.locked_at FROM plan_personnel_drivers ppd
       JOIN plan_line_items pli ON pli.id = ppd.line_item_id
       JOIN plan_versions   pv  ON pv.id  = pli.version_id
       WHERE ppd.id = $1`, [id]
    );
    if (!check.length) return res.status(404).json({ error: 'Personnel driver not found' });
    if (check[0].locked_at) return res.status(409).json({ error: 'Version is locked' });

    const f = req.body;
    const { rows } = await pool.query(
      `UPDATE plan_personnel_drivers SET
         employee_name         = COALESCE($1,  employee_name),
         role_title            = COALESCE($2,  role_title),
         department            = COALESCE($3,  department),
         country               = COALESCE($4,  country),
         is_filled             = COALESCE($5,  is_filled),
         start_date            = COALESCE($6,  start_date),
         end_date              = COALESCE($7,  end_date),
         annual_gross_salary   = COALESCE($8,  annual_gross_salary),
         payroll_burden_rate   = COALESCE($9,  payroll_burden_rate),
         salary_increase_date  = COALESCE($10, salary_increase_date),
         annual_gross_salary_post_increase = COALESCE($11, annual_gross_salary_post_increase),
         annual_bonus          = COALESCE($12, annual_bonus),
         bonus_month           = COALESCE($13, bonus_month),
         notes                 = COALESCE($14, notes),
         updated_by            = $15,
         updated_at            = NOW()
       WHERE id = $16 RETURNING *`,
      [
        f.employee_name ?? null, f.role_title ?? null, f.department ?? null, f.country ?? null,
        f.is_filled ?? null, f.start_date ?? null, f.end_date ?? null,
        f.annual_gross_salary ?? null, f.payroll_burden_rate ?? null,
        f.salary_increase_date ?? null, f.annual_gross_salary_post_increase ?? null,
        f.annual_bonus ?? null, f.bonus_month ?? null,
        f.notes ?? null, req.user.id, id,
      ]
    );
    logAudit(req.user.id, 'plan.personnel.update', `id=${id}`, req);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete a personnel driver
router.delete('/api/plan/line-items/:liId/personnel/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { rows: check } = await pool.query(
      `SELECT ppd.id, pv.locked_at FROM plan_personnel_drivers ppd
       JOIN plan_line_items pli ON pli.id = ppd.line_item_id
       JOIN plan_versions   pv  ON pv.id  = pli.version_id
       WHERE ppd.id = $1`, [id]
    );
    if (!check.length) return res.status(404).json({ error: 'Personnel driver not found' });
    if (check[0].locked_at) return res.status(409).json({ error: 'Version is locked' });
    await pool.query('DELETE FROM plan_personnel_drivers WHERE id=$1', [id]);
    logAudit(req.user.id, 'plan.personnel.delete', `id=${id}`, req);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Generate monthly entries from all personnel drivers on a line item.
// Skips months with is_manual_override=TRUE.
// ?dry_run=true returns a preview without writing.
router.post('/api/plan/line-items/:liId/generate-personnel', requireAuth, requireAdmin, async (req, res) => {
  const lineItemId = parseInt(req.params.liId);
  const dryRun = req.query.dry_run === 'true';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: liRows } = await client.query(
      `SELECT pli.item_id, pv.year, pv.locked_at, pv.id AS version_id
       FROM plan_line_items pli
       JOIN plan_versions pv ON pv.id = pli.version_id
       WHERE pli.id = $1 AND pli.category = 'personnel'`, [lineItemId]
    );
    if (!liRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Personnel line item not found' });
    }
    if (liRows[0].locked_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Version is locked' });
    }

    const { item_id, year, version_id } = liRows[0];

    const { rows: drivers } = await client.query(
      'SELECT * FROM plan_personnel_drivers WHERE line_item_id=$1',
      [lineItemId]
    );
    const { rows: existingEntries } = await client.query(
      'SELECT month, is_manual_override FROM plan_entries WHERE version_id=$1 AND line_item_id=$2',
      [version_id, lineItemId]
    );
    const manualMonths = new Set(
      existingEntries.filter(e => e.is_manual_override).map(e => e.month)
    );

    const generated = spreadPersonnelDrivers(drivers, year)
      .filter(e => !manualMonths.has(e.month));

    if (dryRun) {
      await client.query('ROLLBACK');
      return res.json({
        dry_run: true, year, generated,
        skipped_manual_months: [...manualMonths].sort(),
      });
    }

    for (const e of generated) {
      await client.query(
        `INSERT INTO plan_entries
           (version_id, line_item_id, item_id, month, year, amount, is_manual_override, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,FALSE,$7,NOW())
         ON CONFLICT (version_id, line_item_id, month)
         WHERE line_item_id IS NOT NULL
         DO UPDATE SET amount=$6, is_manual_override=FALSE, updated_by=$7, updated_at=NOW()`,
        [version_id, lineItemId, item_id, e.month, year, e.amount, req.user.id]
      );
    }

    await client.query('COMMIT');
    logAudit(req.user.id, 'plan.personnel.generate',
      `line_item_id=${lineItemId} generated=${generated.length} skipped_manual=${manualMonths.size}`, req);
    res.json({
      ok: true,
      generated: generated.length,
      skipped_manual_months: [...manualMonths].sort(),
    });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// Version-level personnel generation with WAGES / SOCIAL split.
// Gathers all personnel drivers across the version and writes two streams:
//   - gross salary + bonus → 'personnel_wages' line item
//   - employer burden (AG-NK) → 'personnel_social' line item
// Non-manual entries on both targets are cleared first so deletions propagate.
router.post('/api/plan/versions/:vid/generate-personnel', requireAuth, requireAdmin, async (req, res) => {
  const versionId = parseInt(req.params.vid);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: vRows } = await client.query(
      'SELECT year, locked_at FROM plan_versions WHERE id=$1', [versionId]
    );
    if (!vRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Version not found' }); }
    if (vRows[0].locked_at) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Version is locked' }); }
    const year = vRows[0].year;

    const { rows: liRows } = await client.query(
      `SELECT id, item_id FROM plan_line_items WHERE version_id=$1 AND category='personnel'`, [versionId]
    );
    const wagesLi  = liRows.find(l => l.item_id === 'personnel_wages');
    const socialLi = liRows.find(l => l.item_id === 'personnel_social');
    if (!wagesLi || !socialLi) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Personnel line items (wages/social) missing' });
    }

    const liIds = liRows.map(l => l.id);
    const { rows: drivers } = await client.query(
      'SELECT * FROM plan_personnel_drivers WHERE line_item_id = ANY($1)', [liIds]
    );

    const { wages, social } = spreadPersonnelSplit(drivers, year);

    for (const [li, entries] of [[wagesLi, wages], [socialLi, social]]) {
      const { rows: existing } = await client.query(
        'SELECT month FROM plan_entries WHERE version_id=$1 AND line_item_id=$2 AND is_manual_override=TRUE',
        [versionId, li.id]
      );
      const manualMonths = new Set(existing.map(e => e.month));
      // Clear previously generated (non-manual) entries so removals reduce totals
      await client.query(
        'DELETE FROM plan_entries WHERE version_id=$1 AND line_item_id=$2 AND is_manual_override=FALSE',
        [versionId, li.id]
      );
      for (const e of entries) {
        if (manualMonths.has(e.month)) continue;
        await client.query(
          `INSERT INTO plan_entries
             (version_id, line_item_id, item_id, month, year, amount, is_manual_override, updated_by, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,FALSE,$7,NOW())
           ON CONFLICT (version_id, line_item_id, month)
           WHERE line_item_id IS NOT NULL
           DO UPDATE SET amount=$6, is_manual_override=FALSE, updated_by=$7, updated_at=NOW()`,
          [versionId, li.id, li.item_id, e.month, year, e.amount, req.user.id]
        );
      }
    }

    await client.query('COMMIT');
    logAudit(req.user.id, 'plan.personnel.generate.split',
      `version_id=${versionId} wages=${wages.length} social=${social.length}`, req);
    res.json({ ok: true, wages: wages.length, social: social.length });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── PLANNING: OPEX GENERATE ───────────────────────────────────────────

// Generate monthly entries for an opex line item from its revenue drivers.
// Validates category='opex'. Skips is_manual_override months.
router.post('/api/plan/line-items/:liId/generate-opex', requireAuth, requireAdmin, async (req, res) => {
  const lineItemId = parseInt(req.params.liId);
  const dryRun = req.query.dry_run === 'true';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: liRows } = await client.query(
      `SELECT pli.item_id, pv.year, pv.locked_at, pv.id AS version_id
       FROM plan_line_items pli
       JOIN plan_versions pv ON pv.id = pli.version_id
       WHERE pli.id = $1 AND pli.category = 'opex'`, [lineItemId]
    );
    if (!liRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Opex line item not found' });
    }
    if (liRows[0].locked_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Version is locked' });
    }

    const { item_id, year, version_id } = liRows[0];

    const { rows: drivers } = await client.query(
      'SELECT * FROM plan_revenue_drivers WHERE line_item_id=$1',
      [lineItemId]
    );
    const { rows: existingEntries } = await client.query(
      'SELECT month, is_manual_override FROM plan_entries WHERE version_id=$1 AND line_item_id=$2',
      [version_id, lineItemId]
    );
    const manualMonths = new Set(
      existingEntries.filter(e => e.is_manual_override).map(e => e.month)
    );

    const generated = spreadDrivers(drivers, year)
      .filter(e => !manualMonths.has(e.month));

    if (dryRun) {
      await client.query('ROLLBACK');
      return res.json({
        dry_run: true, year, generated,
        skipped_manual_months: [...manualMonths].sort(),
      });
    }

    for (const e of generated) {
      await client.query(
        `INSERT INTO plan_entries
           (version_id, line_item_id, item_id, month, year, amount, is_manual_override, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,FALSE,$7,NOW())
         ON CONFLICT (version_id, line_item_id, month)
         WHERE line_item_id IS NOT NULL
         DO UPDATE SET amount=$6, is_manual_override=FALSE, updated_by=$7, updated_at=NOW()`,
        [version_id, lineItemId, item_id, e.month, year, e.amount, req.user.id]
      );
    }

    await client.query('COMMIT');
    logAudit(req.user.id, 'plan.opex.generate',
      `line_item_id=${lineItemId} generated=${generated.length} skipped_manual=${manualMonths.size}`, req);
    res.json({
      ok: true,
      generated: generated.length,
      skipped_manual_months: [...manualMonths].sort(),
    });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});
