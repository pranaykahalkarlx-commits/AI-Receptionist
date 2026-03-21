require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const { Resend } = require('resend');
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const app  = express();
const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0';

// ─── CORS (fixes preflight 404) ───────────────────────────────
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors()); // handle preflight for ALL routes
app.use(express.json({ limit: '10mb' }));

// ─── DATABASE ─────────────────────────────────────────────────
const DB_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const dbPath = path.join(DB_DIR, 'database.sqlite');

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS otps (
    email      TEXT PRIMARY KEY,
    otp        TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts   INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS user_data (
    email      TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT,
    updated_at INTEGER DEFAULT (strftime('%s','now')),
    PRIMARY KEY (email, key)
  );
`);

console.log('✅ Database ready:', dbPath);

// ─── RESEND EMAIL SETUP ───────────────────────────────────────
// Set these in Railway → Variables tab:
//   RESEND_API_KEY = re_xxxxxxxxxxxxxxxxx  ← from resend.com/api-keys
//   FROM_EMAIL     = info@marketlly.shop   ← your verified sender domain

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL     = process.env.FROM_EMAIL || 'info@marketlly.shop';

const resend = (RESEND_API_KEY && RESEND_API_KEY !== 're_your_api_key_here')
  ? new Resend(RESEND_API_KEY)
  : null;

if (!resend) {
  console.log('⚠️  RESEND_API_KEY not set — OTPs will print to Railway logs (dev mode)');
  console.log('⚠️  Get your key at: https://resend.com/api-keys');
} else {
  console.log('✅ Resend ready — FROM:', FROM_EMAIL);
}

// ─── HELPERS ─────────────────────────────────────────────────
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sendOTPEmail(toEmail, otp) {
  // DEV MODE — no Resend key set
  if (!resend) {
    console.log('');
    console.log('================================================');
    console.log(`🔑 OTP for ${toEmail} : ${otp}`);
    console.log('   Set RESEND_API_KEY in Railway Variables');
    console.log('   to send real emails instead of logging here');
    console.log('================================================');
    console.log('');
    return;
  }

  const { data, error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: toEmail,
    subject: 'Your AI Receptionist Login Code',
    html: `
      <div style="font-family:sans-serif;max-width:420px;margin:0 auto;
                  padding:32px;border:1px solid #e5e7eb;border-radius:16px">
        <div style="text-align:center;margin-bottom:24px">
          <div style="width:52px;height:52px;
                      background:linear-gradient(135deg,#5b5ef4,#7c3aed);
                      border-radius:14px;display:inline-flex;
                      align-items:center;justify-content:center">
            <span style="color:white;font-size:22px">📞</span>
          </div>
          <h2 style="color:#1e2240;margin:12px 0 4px;font-size:20px">AI Receptionist</h2>
          <p style="color:#7077a1;margin:0;font-size:14px">Your one-time login code</p>
        </div>
        <div style="background:#f0f0ff;border:2px solid #e0e0ff;
                    border-radius:12px;padding:24px;text-align:center;margin-bottom:24px">
          <div style="font-size:40px;font-weight:900;letter-spacing:10px;
                      color:#5b5ef4;font-family:monospace">${otp}</div>
        </div>
        <p style="color:#7077a1;font-size:13px;text-align:center;margin:0">
          ⏱ Expires in <strong>5 minutes</strong>.<br>
          Never share this code with anyone.
        </p>
      </div>
    `
  });

  if (error) {
    console.error('❌ Resend error:', error);
    throw new Error(error.message || 'Email send failed');
  }

  console.log(`✅ OTP email sent to ${toEmail} — ID: ${data?.id}`);
}

// ─── FIX: ROOT ROUTE (was giving 404) ────────────────────────
app.get('/', (req, res) => {
  res.json({
    service: 'AI Receptionist API',
    version: '3.0',
    status:  'running ✅',
    email:   resend ? `Resend (${FROM_EMAIL})` : 'Dev mode (OTPs in logs)',
    uptime:  Math.floor(process.uptime()) + 's'
  });
});

// ─── FIX: HEALTH ROUTE ────────────────────────────────────────
app.get('/health', (req, res) => {
  try {
    const users = db.prepare('SELECT COUNT(DISTINCT email) as c FROM user_data').get().c;
    const otps  = db.prepare('SELECT COUNT(*) as c FROM otps').get().c;
    res.json({ status: 'ok', users, pending_otps: otps, uptime: process.uptime() });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ─── FIX: ROBOTS.TXT (stops log spam) ────────────────────────
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send('User-agent: *\nDisallow: /');
});

// ─── SEND OTP ─────────────────────────────────────────────────
app.post('/api/auth/send-otp', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'Valid email is required' });
    }

    const emailNorm = email.toLowerCase().trim();
    const otp       = generateOTP();
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

    // Save to DB (replace if already exists)
    db.prepare(`
      INSERT OR REPLACE INTO otps (email, otp, expires_at, attempts)
      VALUES (?, ?, ?, 0)
    `).run(emailNorm, otp, expiresAt);

    await sendOTPEmail(emailNorm, otp);

    res.json({ success: true, message: 'OTP sent! Check your email.' });

  } catch (err) {
    console.error('❌ send-otp error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to send OTP: ' + err.message
    });
  }
});

// ─── VERIFY OTP ───────────────────────────────────────────────
app.post('/api/auth/verify-otp', (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ success: false, message: 'Email and OTP are required' });
    }

    const emailNorm = email.toLowerCase().trim();
    const row = db.prepare('SELECT * FROM otps WHERE email = ?').get(emailNorm);

    if (!row) {
      return res.status(400).json({
        success: false,
        message: 'No OTP found. Please request a new code.'
      });
    }

    // Check expiry
    if (Date.now() > row.expires_at) {
      db.prepare('DELETE FROM otps WHERE email = ?').run(emailNorm);
      return res.status(400).json({
        success: false,
        message: 'OTP has expired. Please request a new code.'
      });
    }

    // Rate limit — max 5 wrong attempts
    if (row.attempts >= 5) {
      db.prepare('DELETE FROM otps WHERE email = ?').run(emailNorm);
      return res.status(429).json({
        success: false,
        message: 'Too many wrong attempts. Please request a new code.'
      });
    }

    // Wrong OTP
    if (row.otp !== String(otp).trim()) {
      db.prepare('UPDATE otps SET attempts = attempts + 1 WHERE email = ?').run(emailNorm);
      const left = 4 - row.attempts;
      return res.status(400).json({
        success: false,
        message: `Wrong code. ${left} attempt(s) remaining.`
      });
    }

    // ✅ Correct — delete OTP and approve login
    db.prepare('DELETE FROM otps WHERE email = ?').run(emailNorm);
    console.log(`✅ Login verified: ${emailNorm}`);
    res.json({ success: true, message: 'Authentication successful!' });

  } catch (err) {
    console.error('❌ verify-otp error:', err.message);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

// ─── USER DATA: GET ONE KEY ───────────────────────────────────
app.get('/api/user-data', (req, res) => {
  try {
    const { email, key } = req.query;
    if (!email || !key) return res.status(400).json({ error: 'email and key required' });
    const row = db.prepare('SELECT value FROM user_data WHERE email = ? AND key = ?')
                  .get(email.toLowerCase().trim(), key);
    if (!row) return res.status(404).json({ value: null });
    try { res.json({ value: JSON.parse(row.value) }); }
    catch { res.json({ value: row.value }); }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── USER DATA: SAVE ONE KEY ──────────────────────────────────
app.post('/api/user-data', (req, res) => {
  try {
    const { email, key, value } = req.body;
    if (!email || !key) return res.status(400).json({ error: 'email and key required' });
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    db.prepare(`
      INSERT INTO user_data (email, key, value, updated_at)
      VALUES (?, ?, ?, strftime('%s','now'))
      ON CONFLICT(email, key) DO UPDATE SET
        value = excluded.value, updated_at = strftime('%s','now')
    `).run(email.toLowerCase().trim(), key, serialized);
    res.json({ success: true, key });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── USER DATA: BULK SAVE ─────────────────────────────────────
app.post('/api/user-data/bulk', (req, res) => {
  try {
    const { email, data } = req.body;
    if (!email || !data || typeof data !== 'object') {
      return res.status(400).json({ error: 'email and data object required' });
    }
    const emailNorm = email.toLowerCase().trim();
    const upsert = db.prepare(`
      INSERT INTO user_data (email, key, value, updated_at)
      VALUES (?, ?, ?, strftime('%s','now'))
      ON CONFLICT(email, key) DO UPDATE SET
        value = excluded.value, updated_at = strftime('%s','now')
    `);
    db.transaction((entries) => {
      for (const [key, value] of entries) {
        upsert.run(emailNorm, key, typeof value === 'string' ? value : JSON.stringify(value));
      }
    })(Object.entries(data));
    res.json({ success: true, saved: Object.keys(data).length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── USER DATA: GET ALL KEYS ──────────────────────────────────
app.get('/api/user-data/all', (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'email required' });
    const rows = db.prepare('SELECT key, value FROM user_data WHERE email = ?')
                   .all(email.toLowerCase().trim());
    const result = {};
    for (const row of rows) {
      try { result[row.key] = JSON.parse(row.value); }
      catch { result[row.key] = row.value; }
    }
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── USER DATA: DELETE ONE KEY ────────────────────────────────
app.delete('/api/user-data', (req, res) => {
  try {
    const { email, key } = req.query;
    if (!email || !key) return res.status(400).json({ error: 'email and key required' });
    db.prepare('DELETE FROM user_data WHERE email = ? AND key = ?')
      .run(email.toLowerCase().trim(), key);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── USER DATA: DELETE ALL FOR USER ──────────────────────────
app.delete('/api/user-data/all', (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'email required' });
    db.prepare('DELETE FROM user_data WHERE email = ?').run(email.toLowerCase().trim());
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── AUTO CLEANUP EXPIRED OTPs ────────────────────────────────
setInterval(() => {
  try {
    const result = db.prepare('DELETE FROM otps WHERE expires_at < ?').run(Date.now());
    if (result.changes > 0) console.log(`🧹 Cleaned ${result.changes} expired OTP(s)`);
  } catch (err) { console.error('Cleanup error:', err.message); }
}, 10 * 60 * 1000);

// ─── START ────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log('');
  console.log('🚀 AI Receptionist backend running!');
  console.log(`📡 Port     : ${PORT}`);
  console.log(`📁 Database : ${dbPath}`);
  console.log(`📧 Email    : ${resend ? `Resend (${FROM_EMAIL})` : 'DEV MODE — OTPs in Railway logs'}`);
  console.log('');
  console.log('Routes:');
  console.log('  GET  /                    → status ✅');
  console.log('  GET  /health              → health check');
  console.log('  GET  /robots.txt          → no more log spam ✅');
  console.log('  POST /api/auth/send-otp   → send OTP email');
  console.log('  POST /api/auth/verify-otp → verify OTP');
  console.log('  GET  /api/user-data       → get one key');
  console.log('  POST /api/user-data       → save one key');
  console.log('  POST /api/user-data/bulk  → save multiple keys');
  console.log('  GET  /api/user-data/all   → get all user keys');
  console.log('  DELETE /api/user-data     → delete one key');
  console.log('  DELETE /api/user-data/all → delete all user data');
  console.log('');
});
