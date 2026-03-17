require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Resend } = require('resend');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

// --- DATABASE INITIALIZATION ---
const dbPath = path.join(__dirname, 'database.sqlite');
const db = new Database(dbPath);

// Create OTPs table if it doesn't exist
db.prepare(`
    CREATE TABLE IF NOT EXISTS otps (
        email TEXT PRIMARY KEY,
        otp TEXT NOT NULL,
        expires_at INTEGER NOT NULL
    )
`).run();

// Initialize Resend with your API key from .env file
const resend = new Resend(process.env.RESEND_API_KEY || 're_your_api_key_here');

// Helper to generate a 6-digit OTP
function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// 1. Endpoint to Send OTP
app.post('/api/auth/send-otp', async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ success: false, message: 'Email is required' });
    }

    const otp = generateOTP();
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

    try {
        // Store OTP in SQLite (Replace existing if same email)
        const upsert = db.prepare('INSERT OR REPLACE INTO otps (email, otp, expires_at) VALUES (?, ?, ?)');
        upsert.run(email, otp, expiresAt);

        // Send email using Resend
        const { data, error } = await resend.emails.send({
            from: 'info@marketlly.shop',
            to: email,
            subject: 'Your AI Receptionist Login Code',
            html: `
                <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f8fafc; border-radius: 12px;">
                    <div style="text-align: center; margin-bottom: 30px;">
                        <h1 style="color: #0f172a; margin-bottom: 5px;">Your Secure Login Code</h1>
                        <p style="color: #64748b; font-size: 16px;">Use the OTP below to access your AI Receptionist portal.</p>
                    </div>
                    
                    <div style="background-color: #ffffff; padding: 40px; border-radius: 16px; text-align: center; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
                        <h2 style="letter-spacing: 5px; font-size: 36px; color: #3b82f6; margin: 0; padding: 10px; background-color: #f0f9ff; border-radius: 8px; display: inline-block;">
                            ${otp}
                        </h2>
                        <p style="color: #64748b; margin-top: 20px; font-size: 14px;">This code will expire in <b>5 minutes</b>.</p>
                    </div>
                    
                    <div style="margin-top: 30px; text-align: center; color: #94a3b8; font-size: 12px;">
                        <p>If you didn't request this code, you can safely ignore this email.</p>
                        <p>&copy; ${new Date().getFullYear()} AI Receptionist. All rights reserved.</p>
                    </div>
                </div>
            `
        });

        if (error) {
            console.error('Resend API Error:', error);
            return res.status(500).json({ success: false, message: error.message || 'Failed to send OTP email' });
        }

        res.json({ success: true, message: 'OTP sent successfully', data });
    } catch (error) {
        console.error('Unexpected error:', error);
        res.status(500).json({ success: false, message: 'Internal server error while sending email' });
    }
});

// 2. Endpoint to Verify OTP
app.post('/api/auth/verify-otp', (req, res) => {
    const { email, otp } = req.body;

    if (!email || !otp) {
        return res.status(400).json({ success: false, message: 'Email and OTP are required' });
    }

    try {
        const row = db.prepare('SELECT * FROM otps WHERE email = ?').get(email);

        if (!row) {
            return res.status(400).json({ success: false, message: 'No OTP requested for this email' });
        }

        if (Date.now() > row.expires_at) {
            db.prepare('DELETE FROM otps WHERE email = ?').run(email);
            return res.status(400).json({ success: false, message: 'OTP has expired' });
        }

        if (row.otp === otp) {
            // Correct OTP! Clear it so it can't be reused
            db.prepare('DELETE FROM otps WHERE email = ?').run(email);
            res.json({ success: true, message: 'Authentication successful', token: 'mock_jwt_token_here' });
        } else {
            res.status(400).json({ success: false, message: 'Invalid OTP' });
        }
    } catch (error) {
        console.error('Database error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// Periodic Cleanup: Delete expired OTPs every 10 minutes
setInterval(() => {
    const now = Date.now();
    try {
        const info = db.prepare('DELETE FROM otps WHERE expires_at < ?').run(now);
        if (info.changes > 0) {
            console.log(`[Cleanup] Deleted ${info.changes} expired OTP records.`);
        }
    } catch (error) {
        console.error('[Cleanup Error]:', error);
    }
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Database initialized at: ${dbPath}`);
});
