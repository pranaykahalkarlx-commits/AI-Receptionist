const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 3000;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'AI Receptionist <noreply@yourdomain.com>';
const OTP_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
const OTP_LENGTH = 6;

if (!RESEND_API_KEY) {
  console.error('❌ RESEND_API_KEY environment variable is required!');
  process.exit(1);
}

const resend = new Resend(RESEND_API_KEY);

// ─── In-Memory OTP Store ─────────────────────────────────────────────────────
// Structure: { email: { otp, expiresAt, attempts } }
const otpStore = new Map();

// Clean up expired OTPs every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [email, data] of otpStore.entries()) {
    if (now > data.expiresAt) {
      otpStore.delete(email);
    }
  }
}, 5 * 60 * 1000);

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '1mb' }));

// ─── Helpers ──────────────────────────────────────────────────────────────────
function generateOTP() {
  return crypto.randomInt(100000, 999999).toString();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'AI Receptionist Auth Server',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', uptime: process.uptime() });
});

// ─── Send OTP ─────────────────────────────────────────────────────────────────
app.post('/api/auth/send-otp', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Rate limit: 1 OTP per 30 seconds per email
    const existing = otpStore.get(normalizedEmail);
    if (existing && Date.now() < existing.expiresAt - OTP_EXPIRY_MS + 30000) {
      return res.status(429).json({
        success: false,
        message: 'Please wait 30 seconds before requesting a new code.',
      });
    }

    const otp = generateOTP();
    const expiresAt = Date.now() + OTP_EXPIRY_MS;

    otpStore.set(normalizedEmail, { otp, expiresAt, attempts: 0 });

    // Send via Resend
    const { data, error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: normalizedEmail,
      subject: `Your AI Receptionist login code: ${otp}`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin:0;padding:0;background:#eef1f8;font-family:'DM Sans',Arial,sans-serif;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f8;padding:40px 20px;">
            <tr>
              <td align="center">
                <table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 8px 40px rgba(99,102,241,0.12);">
                  <!-- Header -->
                  <tr>
                    <td style="background:linear-gradient(135deg,#5b5ef4,#7c3aed);padding:32px 40px;text-align:center;">
                      <div style="width:52px;height:52px;background:rgba(255,255,255,0.2);border-radius:14px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:16px;">
                        <span style="font-size:24px;">📞</span>
                      </div>
                      <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.02em;">AI Receptionist</h1>
                      <p style="margin:6px 0 0;color:rgba(255,255,255,0.8);font-size:14px;">Your verification code</p>
                    </td>
                  </tr>
                  <!-- Body -->
                  <tr>
                    <td style="padding:40px;">
                      <p style="margin:0 0 24px;color:#1e2240;font-size:15px;line-height:1.6;">
                        Hi there! Use the code below to sign in to your AI Receptionist portal.
                      </p>
                      <!-- OTP Code -->
                      <div style="background:#f0f2ff;border:2px solid rgba(99,102,241,0.2);border-radius:16px;padding:28px;text-align:center;margin:0 0 28px;">
                        <div style="font-size:11px;color:#7077a1;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:12px;">Verification Code</div>
                        <div style="font-size:42px;font-weight:800;letter-spacing:0.15em;color:#5b5ef4;font-family:monospace;">${otp}</div>
                        <div style="font-size:12px;color:#7077a1;margin-top:10px;">Valid for 10 minutes</div>
                      </div>
                      <p style="margin:0 0 12px;color:#4b5280;font-size:13px;line-height:1.7;">
                        If you didn't request this code, you can safely ignore this email.
                        Someone may have typed your email address by mistake.
                      </p>
                      <p style="margin:0;color:#7077a1;font-size:12px;">
                        🔒 Never share this code with anyone. We will never ask for it.
                      </p>
                    </td>
                  </tr>
                  <!-- Footer -->
                  <tr>
                    <td style="background:#f8f9ff;padding:20px 40px;border-top:1px solid rgba(99,102,241,0.1);">
                      <p style="margin:0;color:#7077a1;font-size:12px;text-align:center;">
                        AI Receptionist Portal &nbsp;•&nbsp; Secure Login
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
        </html>
      `,
      text: `Your AI Receptionist login code is: ${otp}\n\nThis code expires in 10 minutes.\n\nIf you didn't request this, please ignore this email.`,
    });

    if (error) {
      console.error('Resend error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to send email. Please try again.',
      });
    }

    console.log(`✅ OTP sent to ${normalizedEmail} (ID: ${data?.id})`);
    res.json({ success: true, message: 'Verification code sent! Check your inbox.' });

  } catch (err) {
    console.error('Send OTP error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// ─── Verify OTP ───────────────────────────────────────────────────────────────
app.post('/api/auth/verify-otp', (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ success: false, message: 'Email and OTP are required.' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const cleanOtp = String(otp).trim();

    const stored = otpStore.get(normalizedEmail);

    if (!stored) {
      return res.status(400).json({ success: false, message: 'No code found for this email. Please request a new one.' });
    }

    if (Date.now() > stored.expiresAt) {
      otpStore.delete(normalizedEmail);
      return res.status(400).json({ success: false, message: 'Code has expired. Please request a new one.' });
    }

    // Increment attempt counter
    stored.attempts = (stored.attempts || 0) + 1;

    // Max 5 attempts per OTP
    if (stored.attempts > 5) {
      otpStore.delete(normalizedEmail);
      return res.status(429).json({ success: false, message: 'Too many attempts. Please request a new code.' });
    }

    if (cleanOtp !== stored.otp) {
      return res.status(400).json({
        success: false,
        message: `Invalid code. ${5 - stored.attempts} attempt(s) remaining.`,
      });
    }

    // ✅ Success — delete OTP so it can't be reused
    otpStore.delete(normalizedEmail);
    console.log(`✅ ${normalizedEmail} verified successfully`);

    res.json({ success: true, message: 'Verified! Welcome to your portal.' });

  } catch (err) {
    console.error('Verify OTP error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// ─── 404 Handler ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.method} ${req.path} not found.` });
});

// ─── Error Handler ────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, message: 'Internal server error.' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 AI Receptionist server running on port ${PORT}`);
  console.log(`📧 Using Resend for email delivery`);
  console.log(`🔗 Health: http://localhost:${PORT}/health`);
});
