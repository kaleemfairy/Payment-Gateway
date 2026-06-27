require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { v4: uuidv4 } = require('uuid');
const { run, get, all, init } = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getSetting(key) {
  const row = await get('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : null;
}

async function getAllSettings() {
  const rows = await all('SELECT key, value FROM settings');
  return rows.reduce((acc, r) => { acc[r.key] = r.value; return acc; }, {});
}

function generateOrderId() {
  const ts   = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `ORD-${ts}-${rand}`;
}

function adminAuth(req, res, next) {
  if (req.headers['x-admin-token'] !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function triggerWebhook(order, event) {
  getSetting('webhook_url').then(url => {
    if (!url) return;
    try {
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event, order, timestamp: new Date().toISOString() }),
      }).catch(() => {});
    } catch (_) {}
  }).catch(() => {});
}

// ── Public API ────────────────────────────────────────────────────────────────

app.get('/api/config', async (req, res) => {
  try {
    const s = await getAllSettings();
    res.json({
      upiId:         s.upi_id,
      merchantName:  s.merchant_name,
      merchantLogo:  s.merchant_logo,
      supportPhone:  s.support_phone,
      supportEmail:  s.support_email,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/orders', async (req, res) => {
  try {
    const { amount, description, customerName, customerEmail } = req.body;
    if (!amount || isNaN(amount) || Number(amount) <= 0)
      return res.status(400).json({ error: 'Valid amount is required' });
    if (!description || !description.trim())
      return res.status(400).json({ error: 'Description is required' });

    const id      = uuidv4();
    const orderId = generateOrderId();
    await run(
      'INSERT INTO orders (id, order_id, amount, description, customer_name, customer_email) VALUES (?,?,?,?,?,?)',
      [id, orderId, Number(amount), description.trim(), customerName || null, customerEmail || null]
    );
    const order = await get('SELECT * FROM orders WHERE id = ?', [id]);
    res.status(201).json({ success: true, order });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/orders/:orderId', async (req, res) => {
  try {
    const order = await get('SELECT * FROM orders WHERE order_id = ?', [req.params.orderId]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/orders/:orderId/submit-utr', async (req, res) => {
  try {
    const { utrId } = req.body;
    if (!utrId || !utrId.trim())
      return res.status(400).json({ error: 'UTR ID is required' });

    const utr = utrId.trim().toUpperCase();
    if (!/^[A-Z0-9]{8,22}$/.test(utr))
      return res.status(400).json({ error: 'Invalid UTR format. Must be 8-22 alphanumeric characters.' });

    const order = await get('SELECT * FROM orders WHERE order_id = ?', [req.params.orderId]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status === 'verified') return res.status(400).json({ error: 'Payment already verified' });
    if (order.status === 'rejected') return res.status(400).json({ error: 'This order has been rejected' });

    const dupe = await get('SELECT order_id FROM orders WHERE utr_id = ?', [utr]);
    if (dupe && dupe.order_id !== order.order_id)
      return res.status(400).json({ error: 'This UTR is already linked to another order' });

    await run(
      "UPDATE orders SET utr_id = ?, status = 'submitted', utr_submitted_at = CURRENT_TIMESTAMP WHERE order_id = ?",
      [utr, req.params.orderId]
    );

    const updated = await get('SELECT * FROM orders WHERE order_id = ?', [req.params.orderId]);
    triggerWebhook(updated, 'utr_submitted');

    // Auto-verify if configured
    const autoMin = parseInt(await getSetting('auto_verify_minutes') || '0', 10);
    if (autoMin > 0) {
      setTimeout(async () => {
        const current = await get('SELECT status FROM orders WHERE order_id = ?', [req.params.orderId]);
        if (current && current.status === 'submitted') {
          await run(
            "UPDATE orders SET status = 'verified', verified_at = CURRENT_TIMESTAMP WHERE order_id = ?",
            [req.params.orderId]
          );
          const verified = await get('SELECT * FROM orders WHERE order_id = ?', [req.params.orderId]);
          triggerWebhook(verified, 'payment_verified');
        }
      }, autoMin * 60 * 1000);
    }

    res.json({ success: true, order: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin API ─────────────────────────────────────────────────────────────────

app.post('/api/admin/login', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Invalid password' });
  res.json({ success: true, token: ADMIN_PASSWORD });
});

app.get('/api/admin/settings', adminAuth, async (req, res) => {
  try { res.json(await getAllSettings()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/settings', adminAuth, async (req, res) => {
  try {
    const allowed = [
      'upi_id','merchant_name','merchant_logo',
      'support_phone','support_email','auto_verify_minutes','webhook_url',
    ];
    for (const key of allowed) {
      if (key in req.body) {
        await run('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', [key, String(req.body[key])]);
      }
    }
    res.json({ success: true, settings: await getAllSettings() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/orders', adminAuth, async (req, res) => {
  try {
    const { status, search, page = 1, limit = 20 } = req.query;
    let q      = 'FROM orders WHERE 1=1';
    const params = [];

    if (status && status !== 'all') { q += ' AND status = ?'; params.push(status); }
    if (search) {
      q += ' AND (order_id LIKE ? OR utr_id LIKE ? OR customer_name LIKE ? OR description LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }

    const total  = (await get(`SELECT COUNT(*) as c ${q}`, params)).c;
    const offset = (Number(page) - 1) * Number(limit);
    const orders = await all(
      `SELECT * ${q} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, Number(limit), offset]
    );
    res.json({ orders, total, page: Number(page), limit: Number(limit) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const [total, pending, submitted, verified, rejected, collected, pendingAmt] = await Promise.all([
      get("SELECT COUNT(*) as c FROM orders"),
      get("SELECT COUNT(*) as c FROM orders WHERE status='pending'"),
      get("SELECT COUNT(*) as c FROM orders WHERE status='submitted'"),
      get("SELECT COUNT(*) as c FROM orders WHERE status='verified'"),
      get("SELECT COUNT(*) as c FROM orders WHERE status='rejected'"),
      get("SELECT COALESCE(SUM(amount),0) as s FROM orders WHERE status='verified'"),
      get("SELECT COALESCE(SUM(amount),0) as s FROM orders WHERE status='submitted'"),
    ]);
    res.json({
      total: total.c, pending: pending.c, submitted: submitted.c,
      verified: verified.c, rejected: rejected.c,
      totalCollected: collected.s, pendingAmount: pendingAmt.s,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/orders/:id/verify', adminAuth, async (req, res) => {
  try {
    const order = await get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    await run(
      "UPDATE orders SET status='verified', verified_at=CURRENT_TIMESTAMP, notes=? WHERE id=?",
      [req.body.notes || null, req.params.id]
    );
    const updated = await get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    triggerWebhook(updated, 'payment_verified');
    res.json({ success: true, order: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/orders/:id/reject', adminAuth, async (req, res) => {
  try {
    const order = await get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    await run(
      "UPDATE orders SET status='rejected', notes=? WHERE id=?",
      [req.body.notes || null, req.params.id]
    );
    const updated = await get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    triggerWebhook(updated, 'payment_rejected');
    res.json({ success: true, order: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/orders/:id/reset', adminAuth, async (req, res) => {
  try {
    const order = await get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    await run(
      "UPDATE orders SET status='pending', utr_id=NULL, utr_submitted_at=NULL, verified_at=NULL, notes=NULL WHERE id=?",
      [req.params.id]
    );
    const updated = await get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    res.json({ success: true, order: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/orders/:id', adminAuth, async (req, res) => {
  try {
    await run('DELETE FROM orders WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/orders', adminAuth, async (req, res) => {
  try {
    const { amount, description, customerName, customerEmail } = req.body;
    if (!amount || isNaN(amount) || Number(amount) <= 0)
      return res.status(400).json({ error: 'Valid amount is required' });
    if (!description || !description.trim())
      return res.status(400).json({ error: 'Description is required' });

    const id      = uuidv4();
    const orderId = generateOrderId();
    await run(
      'INSERT INTO orders (id, order_id, amount, description, customer_name, customer_email) VALUES (?,?,?,?,?,?)',
      [id, orderId, Number(amount), description.trim(), customerName || null, customerEmail || null]
    );
    const order = await get('SELECT * FROM orders WHERE id = ?', [id]);
    res.status(201).json({ success: true, order });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Frontend routes ───────────────────────────────────────────────────────────

app.get('/pay/:orderId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'payment.html'));
});
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Boot ──────────────────────────────────────────────────────────────────────

init().then(() => {
  app.listen(PORT, () => {
    console.log(`\nUPI Payment Gateway running at http://localhost:${PORT}`);
    console.log(`  Payment page : http://localhost:${PORT}/pay/<ORDER_ID>`);
    console.log(`  Admin panel  : http://localhost:${PORT}/admin`);
    console.log(`  Admin pass   : ${ADMIN_PASSWORD}\n`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
