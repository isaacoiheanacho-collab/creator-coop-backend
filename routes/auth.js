const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const jwt = require('jsonwebtoken');
const authMiddleware = require('../authMiddleware');

// ==================== EMAIL SERVICE (Brevo) ====================
const { sendResetPasswordEmail, sendVerificationEmail } = require('../utils/emailService');

// ==================== HELPER FUNCTIONS ====================

function generateResetToken() {
  return crypto.randomBytes(32).toString('hex');
}

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ==================== AUTH ROUTES ====================

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { username, email, password, social_profile_url } = req.body;
  
  // ✅ Updated: Accept social_profile_url instead of facebook_profile_url
  if (!username || !email || !password || !social_profile_url) {
    return res.status(400).json({ error: 'All fields are required. Social profile URL is mandatory.' });
  }
  
  try {
    const userExist = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userExist.rows.length > 0) {
      return res.status(400).json({ error: 'Email already exists.' });
    }
    
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    
    const newUser = await db.query(
      `INSERT INTO users (username, email, password_hash, social_profile_url, email_verified)
       VALUES ($1, $2, $3, $4, FALSE)
       RETURNING user_id, username, email, social_profile_url`,
      [username, email, passwordHash, social_profile_url]
    );
    
    res.status(201).json({
      message: 'Registration successful! Please verify your email.',
      user: newUser.rows[0]
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error during registration.' });
  }
});

// POST /api/auth/send-verification
router.post('/send-verification', async (req, res) => {
  const { email } = req.body;
  
  if (!email) {
    return res.status(400).json({ error: 'Email address is required.' });
  }

  try {
    const userCheck = await db.query(
      'SELECT user_id, username, email_verified FROM users WHERE email = $1',
      [email]
    );
    
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found. Please register first.' });
    }
    
    if (userCheck.rows[0].email_verified) {
      return res.status(400).json({ error: 'Email already verified.' });
    }

    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    await db.query(`
      CREATE TABLE IF NOT EXISTS email_verifications (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        otp VARCHAR(6) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        used BOOLEAN DEFAULT FALSE
      )
    `);
    
    await db.query('DELETE FROM email_verifications WHERE email = $1 AND used = FALSE', [email]);
    
    await db.query(
      'INSERT INTO email_verifications (email, otp, expires_at) VALUES ($1, $2, $3)',
      [email, otp, expiresAt]
    );

    const emailResult = await sendVerificationEmail(email, otp, userCheck.rows[0].username);
    
    if (emailResult.success) {
      res.json({ 
        message: 'Verification code sent to your email.',
        dev_otp: process.env.NODE_ENV !== 'production' ? otp : undefined
      });
    } else {
      res.status(500).json({ error: 'Failed to send verification email. Please try again.' });
    }
  } catch (err) {
    console.error('Send verification error:', err);
    res.status(500).json({ error: 'Failed to send verification code.' });
  }
});

// POST /api/auth/verify-email
router.post('/verify-email', async (req, res) => {
  const { email, otp } = req.body;
  
  if (!email || !otp) {
    return res.status(400).json({ error: 'Email and verification code are required.' });
  }

  try {
    const otpCheck = await db.query(
      `SELECT id, expires_at FROM email_verifications 
       WHERE email = $1 AND otp = $2 AND used = FALSE
       ORDER BY created_at DESC LIMIT 1`,
      [email, otp]
    );
    
    if (otpCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid verification code.' });
    }
    
    const record = otpCheck.rows[0];
    
    if (new Date(record.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Verification code has expired. Please request a new one.' });
    }
    
    await db.query('UPDATE email_verifications SET used = TRUE WHERE id = $1', [record.id]);
    await db.query('UPDATE users SET email_verified = TRUE WHERE email = $1', [email]);
    
    res.json({ 
      message: 'Email verified successfully! You can now log in.',
      verified: true
    });
  } catch (err) {
    console.error('Email verification error:', err);
    res.status(500).json({ error: 'Verification failed. Please try again.' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required.' });
  }
  try {
    const userQuery = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userQuery.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid credentials.' });
    }
    const user = userQuery.rows[0];
    
    if (!user.email_verified) {
      return res.status(401).json({ 
        error: 'Please verify your email before logging in. Check your inbox for the verification code.',
        needs_verification: true,
        email: user.email
      });
    }
    
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ error: 'Invalid credentials.' });
    }
    const token = jwt.sign(
      { user_id: user.user_id },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.status(200).json({
      message: 'Login successful!',
      token,
      user: {
        id: user.user_id,
        username: user.username,
        email: user.email,
        social_profile_url: user.social_profile_url,
        email_verified: user.email_verified
      }
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error during login.' });
  }
});

// GET /api/auth/me
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const userRes = await db.query(
      `SELECT user_id, username, email, social_profile_url, notification_prefs, 
              email_verified, country, phone, social_links
       FROM users
       WHERE user_id = $1`,
      [req.user.user_id]
    );
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const subRes = await db.query(
      `SELECT status, expires_at FROM subscriptions
       WHERE user_id = $1 AND status = 'active' AND expires_at > NOW()`,
      [req.user.user_id]
    );
    const subscription_active = subRes.rows.length > 0;
    const subscription_expiry = subscription_active ? subRes.rows[0].expires_at : null;

    res.json({
      user: userRes.rows[0],
      subscription_active,
      subscription_expiry
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/update-profile
router.post('/update-profile', authMiddleware, async (req, res) => {
  const { username, social_profile_url, phone, country, social_links } = req.body;
  const { user_id } = req.user;
  
  try {
    await db.query(
      `UPDATE users SET 
        username = COALESCE($1, username),
        social_profile_url = COALESCE($2, social_profile_url),
        phone = COALESCE($3, phone),
        country = COALESCE($4, country),
        social_links = COALESCE($5, social_links)
       WHERE user_id = $6`,
      [username, social_profile_url, phone, country, social_links, user_id]
    );
    res.json({ message: 'Profile updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error updating profile' });
  }
});

// POST /api/auth/change-password
router.post('/change-password', authMiddleware, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const { user_id } = req.user;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password are required.' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  }

  try {
    const userRes = await db.query('SELECT password_hash FROM users WHERE user_id = $1', [user_id]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const isValid = await bcrypt.compare(currentPassword, userRes.rows[0].password_hash);
    if (!isValid) return res.status(401).json({ error: 'Current password is incorrect' });

    const newHash = await bcrypt.hash(newPassword, 10);
    await db.query('UPDATE users SET password_hash = $1 WHERE user_id = $2', [newHash, user_id]);

    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== PASSWORD RESET ====================

router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  
  if (!email) {
    return res.status(400).json({ error: 'Email address is required.' });
  }

  try {
    const userRes = await db.query('SELECT user_id, username FROM users WHERE email = $1', [email]);
    if (userRes.rows.length === 0) {
      return res.status(200).json({ message: 'If an account exists with that email, a reset link has been sent.' });
    }

    const user = userRes.rows[0];
    const resetToken = generateResetToken();
    const tokenExpiry = new Date();
    tokenExpiry.setHours(tokenExpiry.getHours() + 1);

    await db.query(`
      CREATE TABLE IF NOT EXISTS password_resets (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(user_id) ON DELETE CASCADE,
        token VARCHAR(255) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        used BOOLEAN DEFAULT FALSE
      )
    `);

    await db.query('DELETE FROM password_resets WHERE user_id = $1 AND used = FALSE', [user.user_id]);
    await db.query(
      'INSERT INTO password_resets (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [user.user_id, resetToken, tokenExpiry]
    );

    const isLocalhost = req.get('host').includes('localhost') || req.get('host').includes('127.0.0.1');
    const frontendUrl = isLocalhost 
      ? 'http://localhost:3000'
      : 'https://creatorcooptechnologies.com';
    
    const resetLink = `${frontendUrl}/reset-password.html?token=${resetToken}&email=${encodeURIComponent(email)}`;
    
    const isProduction = process.env.NODE_ENV === 'production';

    if (isProduction && process.env.BREVO_API_KEY) {
      const emailResult = await sendResetPasswordEmail(email, resetLink, user.username);
      if (emailResult.success) {
        console.log(`✅ Password reset email sent to ${email}`);
        res.status(200).json({ 
          message: 'If an account exists with that email, a reset link has been sent to your inbox.'
        });
      } else {
        console.error(`❌ Failed to send reset email to ${email}:`, emailResult.error);
        res.status(200).json({ 
          message: 'If an account exists with that email, a reset link has been sent to your inbox.'
        });
      }
    } else {
      console.log('\n🔐 ===== PASSWORD RESET LINK (DEVELOPMENT) =====');
      console.log(`Email: ${email}`);
      console.log(`Reset Link: ${resetLink}`);
      console.log(`Token: ${resetToken}`);
      console.log(`Expires: ${tokenExpiry.toISOString()}`);
      console.log('===============================================\n');
      
      res.status(200).json({ 
        message: 'If an account exists with that email, a reset link has been generated.',
        reset_link: resetLink,
        dev_token: resetToken
      });
    }
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Server error. Please try again later.' });
  }
});

router.post('/reset-password', async (req, res) => {
  const { token, email, new_password } = req.body;
  
  if (!token || !email || !new_password) {
    return res.status(400).json({ error: 'Token, email, and new password are required.' });
  }
  if (new_password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  try {
    const resetRes = await db.query(
      `SELECT pr.user_id, pr.token, pr.expires_at, pr.used, u.email
       FROM password_resets pr
       JOIN users u ON pr.user_id = u.user_id
       WHERE pr.token = $1 AND u.email = $2`,
      [token, email]
    );

    if (resetRes.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid reset token. Please request a new password reset.' });
    }

    const record = resetRes.rows[0];

    if (record.used) {
      return res.status(400).json({ error: 'This reset link has already been used. Please request a new one.' });
    }

    if (new Date(record.expires_at) < new Date()) {
      return res.status(400).json({ error: 'This reset link has expired. Please request a new one.' });
    }

    const userId = record.user_id;
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(new_password, salt);

    await db.query('UPDATE users SET password_hash = $1 WHERE user_id = $2', [passwordHash, userId]);
    await db.query('UPDATE password_resets SET used = TRUE WHERE user_id = $1 AND token = $2', [userId, token]);

    console.log(`✅ Password reset successfully for user ${userId} (${email})`);

    res.json({ message: 'Password has been reset successfully. You can now log in with your new password.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Server error. Please try again later.' });
  }
});

module.exports = router;