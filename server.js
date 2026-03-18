require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Resend } = require('resend');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(cors());

// --- RAILWAY DATABASE INITIALIZATION ---
const DB_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const dbPath = path.join(DB_DIR, 'database.sqlite');

if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
}

const db = new Database(dbPath);

db.prepare(`
    CREATE TABLE IF NOT EXISTS otps (
        email TEXT PRIMARY KEY,
        otp TEXT NOT NULL,
        expires_at INTEGER NOT NULL
    )
`).run();

const resend = new Resend(process.env.RESEND_API_KEY || 're_your_api_key_here');

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

app.post('/api/auth/send-otp', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email is required' });

    const otp = generateOTP();
    const expiresAt = Date.now() + 5 * 60 * 1000; 

    try {
        const upsert = db.prepare('INSERT OR REPLACE INTO otps (email, otp, expires_at) VALUES (?, ?, ?)');
        upsert.run(email, otp, expiresAt);

        const { data, error } = await resend.emails.send({
            from: 'info@marketlly.shop', 
            to: email,
            subject: 'Your AI Receptionist Login Code',
            html: `
                <div style="font-family: sans-serif; text-align: center; padding: 20px;">
                    <h1>Your Secure Login Code</h1>
                    <h2 style="letter-spacing: 5px; color: #3b82f6;">${otp}</h2>
                    <p>This code will expire in 5 minutes.</p>
                </div>
            `
        });

        if (error) return res.status(500).json({ success: false, message: error.message });
        res.json({ success: true, message: 'OTP sent successfully', data });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

app.post('/api/auth/verify-otp', (req, res) => {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ success: false, message: 'Missing data' });

    try {
        const row = db.prepare('SELECT * FROM otps WHERE email = ?').get(email);
        if (!row) return res.status(400).json({ success: false, message: 'No OTP requested' });

        if (Date.now() > row.expires_at) {
            db.prepare('DELETE FROM otps WHERE email = ?').run(email);
            return res.status(400).json({ success: false, message: 'OTP expired' });
        }

        if (row.otp === otp) {
            db.prepare('DELETE FROM otps WHERE email = ?').run(email);
            res.json({ success: true, message: 'Authentication successful', token: 'mock_jwt_token_here' });
        } else {
            res.status(400).json({ success: false, message: 'Invalid OTP' });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

setInterval(() => {
    try {
        db.prepare('DELETE FROM otps WHERE expires_at < ?').run(Date.now());
    } catch (error) {
        console.error('[Cleanup Error]:', error);
    }
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
    console.log(`Server running on http://${HOST}:${PORT}`);
});
