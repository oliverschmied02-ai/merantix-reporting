import express from 'express';
import { pool } from '../db.js';
import { requireAuth, requireAdmin, logAudit } from '../middleware.js';
import { allocate } from '../../lib/plan-allocation.js';

export const router = express.Router();

// ── PLANNING: COST ALLOCATION ─────────────────────────────────────────

const VALID_ALLOC_METHODS = new Set(['fixed_pct', 'equal_split', 'manual']);

// List allocation rules for a version
router.get('/api/plan/versions/:vId/allocation-rules', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT par.*, pli.label AS source_label
       FROM plan_allocation_rules par
       JOIN plan_line_items pli ON pli.id = par.source_line_item_id
       WHERE par.version_id = $1
       ORDER BY par.id`,
      [parseInt(req.params.vId)]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get one rule with its targets
router.get('/api/plan/allocation-rules/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { rows: rule } = await pool.query(
      `SELECT par.*, pli.label AS source_label
       FROM plan_allocation_rules par
       JOIN plan_line_items pli ON pli.id = par.source_line_item_id
       WHERE par.id = $1`, [id]
    );
    if (!rule.length) return res.status(404).json({ error: 'Rule not found' });
    const { rows: targets } = await pool.query(
      'SELECT * FROM plan_allocation_targets WHERE rule_id=$1 ORDER BY sort_order, id', [id]
    );
    res.json({ ...rule[0], targets });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create a rule
router.post('/api/plan/versions/:vId/allocation-rules', requireAuth, requireAdmin, async (req, res) => {
  try {
    const versionId = parseInt(req.params.vId);
    const { label, source_line_item_id, method = 'fixed_pct', notes, targets = [] } = req.body;

    if (!label) return res.status(400).json({ error: 'label is required' });
    if (!source_line_item_id) return res.status(400).json({ error: 'source_line_item_id is required' });
    if (!VALID_ALLOC_METHODS.has(method))
      return res.status(400).json({ error: `method must be one of: ${[...VALID_ALLOC_METHODS].join(', ')}` });

    if (method === 'fixed_pct' && targets.length) {
      const totalPct = targets.reduce((s, t) => s + (Number(t.pct_share) || 0), 0);
      if (totalPct > 100.0001)
        return res.status(400).json({ error: `pct_share values sum to ${totalPct.toFixed(2)}%, must be ≤ 100` });
    }

    const { rows: vCheck } = await pool.query(
      'SELECT locked_at FROM plan_versions WHERE id=$1', [versionId]
    );
    if (!vCheck.length) return res.status(404).json({ error: 'Version not found' });
    if (vCheck[0].locked_at) return res.status(409).json({ error: 'Version is locked' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: ruleRows } = await client.query(
        `INSERT INTO plan_allocation_rules
           (version_id, label, source_line_item_id, method, notes, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING *`,
        [versionId, label, source_line_item_id, method, notes || null, req.user.id]
      );
      const rule = ruleRows[0];

      const insertedTargets = [];
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        const { rows: tr } = await client.query(
          `INSERT INTO plan_allocation_targets
             (rule_id, label, entity, fund_ref, pct_share, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [rule.id, t.label, t.entity || null, t.fund_ref || null,
           t.pct_share ?? null, t.sort_order ?? i]
        );
        insertedTargets.push(tr[0]);
      }

      await client.query('COMMIT');
      logAudit(req.user.id, 'plan.allocation.create',
        `rule_id=${rule.id} method=${method} targets=${insertedTargets.length}`, req);
      res.status(201).json({ ...rule, targets: insertedTargets });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally { client.release(); }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update rule metadata (not targets — manage targets separately)
router.patch('/api/plan/allocation-rules/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { label, method, notes, is_active } = req.body;

    if (method !== undefined && !VALID_ALLOC_METHODS.has(method))
      return res.status(400).json({ error: `method must be one of: ${[...VALID_ALLOC_METHODS].join(', ')}` });

    const { rows: check } = await pool.query(
      `SELECT par.id, pv.locked_at FROM plan_allocation_rules par
       JOIN plan_versions pv ON pv.id = par.version_id WHERE par.id=$1`, [id]
    );
    if (!check.length) return res.status(404).json({ error: 'Rule not found' });
    if (check[0].locked_at) return res.status(409).json({ error: 'Version is locked' });

    const { rows } = await pool.query(
      `UPDATE plan_allocation_rules SET
         label      = COALESCE($1, label),
         method     = COALESCE($2, method),
         notes      = COALESCE($3, notes),
         is_active  = COALESCE($4, is_active),
         updated_by = $5, updated_at = NOW()
       WHERE id=$6 RETURNING *`,
      [label ?? null, method ?? null, notes ?? null, is_active ?? null, req.user.id, id]
    );
    logAudit(req.user.id, 'plan.allocation.update', `rule_id=${id}`, req);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete a rule
router.delete('/api/plan/allocation-rules/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { rows: check } = await pool.query(
      `SELECT par.id, pv.locked_at FROM plan_allocation_rules par
       JOIN plan_versions pv ON pv.id = par.version_id WHERE par.id=$1`, [id]
    );
    if (!check.length) return res.status(404).json({ error: 'Rule not found' });
    if (check[0].locked_at) return res.status(409).json({ error: 'Version is locked' });
    await pool.query('DELETE FROM plan_allocation_rules WHERE id=$1', [id]);
    logAudit(req.user.id, 'plan.allocation.delete', `rule_id=${id}`, req);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Targets ───────────────────────────────────────────────────────────

// Upsert all targets for a rule (replaces the current target list)
router.put('/api/plan/allocation-rules/:id/targets', requireAuth, requireAdmin, async (req, res) => {
  try {
    const ruleId = parseInt(req.params.id);
    const { targets = [] } = req.body;

    const { rows: check } = await pool.query(
      `SELECT par.id, par.method, pv.locked_at FROM plan_allocation_rules par
       JOIN plan_versions pv ON pv.id = par.version_id WHERE par.id=$1`, [ruleId]
    );
    if (!check.length) return res.status(404).json({ error: 'Rule not found' });
    if (check[0].locked_at) return res.status(409).json({ error: 'Version is locked' });

    if (check[0].method === 'fixed_pct' && targets.length) {
      const totalPct = targets.reduce((s, t) => s + (Number(t.pct_share) || 0), 0);
      if (totalPct > 100.0001)
        return res.status(400).json({ error: `pct_share values sum to ${totalPct.toFixed(2)}%, must be ≤ 100` });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM plan_allocation_targets WHERE rule_id=$1', [ruleId]);
      const inserted = [];
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        const { rows } = await client.query(
          `INSERT INTO plan_allocation_targets
             (rule_id, label, entity, fund_ref, pct_share, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [ruleId, t.label, t.entity || null, t.fund_ref || null,
           t.pct_share ?? null, t.sort_order ?? i]
        );
        inserted.push(rows[0]);
      }
      await client.query('COMMIT');
      logAudit(req.user.id, 'plan.allocation.targets.update',
        `rule_id=${ruleId} count=${inserted.length}`, req);
      res.json(inserted);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally { client.release(); }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Generate ──────────────────────────────────────────────────────────

// Generate allocation results for a rule from current source line item entries.
// For 'manual' method, existing results are preserved unless overwritten.
// ?dry_run=true returns the computed values without writing to DB.
router.post('/api/plan/allocation-rules/:id/generate', requireAuth, requireAdmin, async (req, res) => {
  const ruleId = parseInt(req.params.id);
  const dryRun = req.query.dry_run === 'true';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: ruleRows } = await client.query(
      `SELECT par.*, pv.year, pv.locked_at
       FROM plan_allocation_rules par
       JOIN plan_versions pv ON pv.id = par.version_id
       WHERE par.id=$1`, [ruleId]
    );
    if (!ruleRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Rule not found' }); }
    if (ruleRows[0].locked_at) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Version is locked' }); }

    const rule = ruleRows[0];

    // Load source line item's monthly entries
    const { rows: srcEntries } = await client.query(
      `SELECT month, year, amount FROM plan_entries
       WHERE line_item_id=$1 AND year=$2
       ORDER BY month`,
      [rule.source_line_item_id, rule.year]
    );

    // Load targets
    const { rows: targets } = await client.query(
      'SELECT * FROM plan_allocation_targets WHERE rule_id=$1 ORDER BY sort_order, id', [ruleId]
    );
    if (!targets.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Rule has no targets' }); }

    // For manual method, load existing manual results so they are preserved
    if (rule.method === 'manual') {
      const { rows: existingManual } = await client.query(
        'SELECT target_id, month, allocated_amount FROM plan_allocation_results WHERE rule_id=$1 AND is_manual=TRUE',
        [ruleId]
      );
      // Attach manual_amounts to each target
      for (const t of targets) {
        t.manual_amounts = {};
        for (const r of existingManual) {
          if (r.target_id === t.id) t.manual_amounts[r.month] = r.allocated_amount;
        }
      }
    }

    const computed = allocate(
      srcEntries.map(e => ({ month: e.month, year: e.year, amount: Number(e.amount) })),
      targets,
      rule.method
    );

    if (dryRun) {
      await client.query('ROLLBACK');
      return res.json({ dry_run: true, year: rule.year, computed });
    }

    for (const r of computed) {
      await client.query(
        `INSERT INTO plan_allocation_results
           (rule_id, target_id, month, year, source_amount, allocated_amount, is_manual, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,FALSE,$7,NOW())
         ON CONFLICT (rule_id, target_id, month, year)
         DO UPDATE SET
           source_amount    = EXCLUDED.source_amount,
           allocated_amount = EXCLUDED.allocated_amount,
           is_manual        = FALSE,
           updated_by       = EXCLUDED.updated_by,
           updated_at       = NOW()`,
        [ruleId, r.target_id, r.month, r.year, r.source_amount, r.allocated_amount, req.user.id]
      );
    }

    await client.query('COMMIT');
    logAudit(req.user.id, 'plan.allocation.generate',
      `rule_id=${ruleId} method=${rule.method} rows=${computed.length}`, req);
    res.json({ ok: true, generated: computed.length, year: rule.year });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// Save manual allocation amounts for a target
router.put('/api/plan/allocation-rules/:id/targets/:targetId/manual', requireAuth, requireAdmin, async (req, res) => {
  try {
    const ruleId   = parseInt(req.params.id);
    const targetId = parseInt(req.params.targetId);
    const { amounts = {} } = req.body; // { month: amount, ... }

    const { rows: check } = await pool.query(
      `SELECT par.id, pv.locked_at, par.method FROM plan_allocation_rules par
       JOIN plan_versions pv ON pv.id = par.version_id WHERE par.id=$1`, [ruleId]
    );
    if (!check.length) return res.status(404).json({ error: 'Rule not found' });
    if (check[0].locked_at) return res.status(409).json({ error: 'Version is locked' });
    if (check[0].method !== 'manual')
      return res.status(400).json({ error: 'Manual amounts only apply to method=manual rules' });

    const { rows: vRow } = await pool.query(
      `SELECT pv.year FROM plan_allocation_rules par
       JOIN plan_versions pv ON pv.id = par.version_id WHERE par.id=$1`, [ruleId]
    );
    const year = vRow[0]?.year;

    for (const [month, amount] of Object.entries(amounts)) {
      await pool.query(
        `INSERT INTO plan_allocation_results
           (rule_id, target_id, month, year, source_amount, allocated_amount, is_manual, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,0,$5,TRUE,$6,NOW())
         ON CONFLICT (rule_id, target_id, month, year)
         DO UPDATE SET allocated_amount=EXCLUDED.allocated_amount,
                       is_manual=TRUE, updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
        [ruleId, targetId, Number(month), year, Number(amount), req.user.id]
      );
    }
    logAudit(req.user.id, 'plan.allocation.manual',
      `rule_id=${ruleId} target_id=${targetId} months=${Object.keys(amounts).length}`, req);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get allocation results for a rule
router.get('/api/plan/allocation-rules/:id/results', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT par_r.*, pat.label AS target_label, pat.entity, pat.fund_ref
       FROM plan_allocation_results par_r
       JOIN plan_allocation_targets pat ON pat.id = par_r.target_id
       WHERE par_r.rule_id=$1
       ORDER BY par_r.target_id, par_r.month`,
      [parseInt(req.params.id)]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
