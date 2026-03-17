require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Resend } = require('resend');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());
app.use(cors());

// --- DATABASE INITIALIZATION (PostgreSQL) ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Create OTPs table if it doesn't exist
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS otps (
                email TEXT PRIMARY KEY,
                otp TEXT NOT NULL,
                expires_at BIGINT NOT NULL
            )
        `);
        console.log('[DB] OTPs table ready.');
    } catch (err) {
        console.error('[DB] Failed to initialize database:', err);
        process.exit(1); // Stop server if DB fails
    }
}

// Initialize Resend
const resend = new Resend(process.env.RESEND_API_KEY);

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret_in_env';

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
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes from now

    try {
        // Store OTP in PostgreSQL (upsert)
        await pool.query(
            `INSERT INTO otps (email, otp, expires_at)
             VALUES ($1, $2, $3)
             ON CONFLICT (email) DO UPDATE SET otp = $2, expires_at = $3`,
            [email, otp, expiresAt]
        );

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

        res.json({ success: true, message: 'OTP sent successfully' });
    } catch (err) {
        console.error('Unexpected error:', err);
        res.status(500).json({ success: false, message: 'Internal server error while sending email' });
    }
});

// 2. Endpoint to Verify OTP
app.post('/api/auth/verify-otp', async (req, res) => {
    const { email, otp } = req.body;

    if (!email || !otp) {
        return res.status(400).json({ success: false, message: 'Email and OTP are required' });
    }

    try {
        const result = await pool.query('SELECT * FROM otps WHERE email = $1', [email]);
        const row = result.rows[0];

        if (!row) {
            return res.status(400).json({ success: false, message: 'No OTP requested for this email' });
        }

        if (Date.now() > parseInt(row.expires_at)) {
            await pool.query('DELETE FROM otps WHERE email = $1', [email]);
            return res.status(400).json({ success: false, message: 'OTP has expired' });
        }

        if (row.otp === otp) {
            // Correct OTP — delete it so it can't be reused
            await pool.query('DELETE FROM otps WHERE email = $1', [email]);

            // Generate a real JWT token
            const token = jwt.sign(
                { email },
                JWT_SECRET,
                { expiresIn: '7d' }
            );

            res.json({ success: true, message: 'Authentication successful', token });
        } else {
            res.status(400).json({ success: false, message: 'Invalid OTP' });
        }
    } catch (err) {
        console.error('Database error:', err);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// Periodic Cleanup: Delete expired OTPs every 10 minutes
setInterval(async () => {
    const now = Date.now();
    try {
        const result = await pool.query('DELETE FROM otps WHERE expires_at < $1', [now]);
        if (result.rowCount > 0) {
            console.log(`[Cleanup] Deleted ${result.rowCount} expired OTP records.`);
        }
    } catch (err) {
        console.error('[Cleanup Error]:', err);
    }
}, 10 * 60 * 1000);

// Start server AFTER DB is ready
const PORT = process.env.PORT || 3000;
initDB().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server running on port ${PORT}`);
    });
});
