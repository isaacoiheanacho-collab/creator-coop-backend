const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const jwt = require('jsonwebtoken');
const authMiddleware = require('../authMiddleware');

// ==================== HELPER FUNCTIONS ====================

/**
 * Generate a secure random token for password reset
 */
function generateResetToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ==================== AUTH ROUTES ====================

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { username, email, password, facebook_profile_url } = req.body;
  if (!username || !email || !password || !facebook_profile_url) {
    return res.status(400).json({ error: 'All fields are required.' });
  }
  try {
    const userExist = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userExist.rows.length > 0) {
      return res.status(400).json({ error: 'Email already exists.' });
    }
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    const newUser = await db.query(
      `INSERT INTO users (username, email, password_hash, facebook_profile_url)
       VALUES ($1, $2, $3, $4)
       RETURNING user_id, username, email, facebook_profile_url`,
      [username, email, passwordHash, facebook_profile_url]
    );
    res.status(201).json({
      message: 'Registration successful! Please log in.',
      user: newUser.rows[0]
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error during registration.' });
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
        facebook_profile_url: user.facebook_profile_url
      }
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error during login.' });
  }
});

// GET /api/auth/me – returns user + subscription status + expiry
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const userRes = await db.query(
      `SELECT user_id, username, email, facebook_profile_url, notification_prefs
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

// POST /api/auth/update-profile – update username and Facebook profile URL
router.post('/update-profile', authMiddleware, async (req, res) => {
  const { username, facebook_profile_url } = req.body;
  const { user_id } = req.user;
  try {
    await db.query(
      'UPDATE users SET username = $1, facebook_profile_url = $2 WHERE user_id = $3',
      [username, facebook_profile_url, user_id]
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

// ==================== PASSWORD RESET (TOKEN-BASED) ====================

// POST /api/auth/forgot-password - Generate reset token and return reset link
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  
  if (!email) {
    return res.status(400).json({ error: 'Email address is required.' });
  }

  try {
    // Check if user exists
    const userRes = await db.query('SELECT user_id, username FROM users WHERE email = $1', [email]);
    if (userRes.rows.length === 0) {
      // For security, don't reveal that email doesn't exist
      return res.status(200).json({ message: 'If an account exists with that email, a reset link has been generated.' });
    }

    const user = userRes.rows[0];
    
    // Generate reset token (expires in 1 hour)
    const resetToken = generateResetToken();
    const tokenExpiry = new Date();
    tokenExpiry.setHours(tokenExpiry.getHours() + 1);

    // Create password_resets table if not exists
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

    // Delete any existing unused tokens for this user
    await db.query('DELETE FROM password_resets WHERE user_id = $1 AND used = FALSE', [user.user_id]);
    
    // Insert new token
    await db.query(
      'INSERT INTO password_resets (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [user.user_id, resetToken, tokenExpiry]
    );

    // Build reset link (works with both localhost and production)
    const isLocalhost = req.get('host').includes('localhost') || req.get('host').includes('127.0.0.1');
    const baseUrl = isLocalhost 
      ? `http://${req.get('host')}`
      : `https://${req.get('host')}`;
    
    const resetLink = `${baseUrl}/reset-password.html?token=${resetToken}&email=${encodeURIComponent(email)}`;
    
    // Log the reset link (in production, you would send this via email)
    console.log('\n🔐 ===== PASSWORD RESET LINK =====');
    console.log(`Email: ${email}`);
    console.log(`Reset Link: ${resetLink}`);
    console.log(`Token: ${resetToken}`);
    console.log(`Expires: ${tokenExpiry.toISOString()}`);
    console.log('================================\n');

    // Return success message (in production, you'd send email and not return the link)
    // For now, return the link in development for testing
    const isProduction = process.env.NODE_ENV === 'production';
    
    res.status(200).json({ 
      message: 'If an account exists with that email, a reset link has been generated.',
      reset_link: !isProduction ? resetLink : undefined,
      dev_token: !isProduction ? resetToken : undefined
    });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Server error. Please try again later.' });
  }
});

// POST /api/auth/reset-password - Reset password using token
router.post('/reset-password', async (req, res) => {
  const { token, email, new_password } = req.body;
  
  if (!token || !email || !new_password) {
    return res.status(400).json({ error: 'Token, email, and new password are required.' });
  }
  if (new_password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  try {
    // Find valid reset token
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

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(new_password, salt);

    // Update password
    await db.query('UPDATE users SET password_hash = $1 WHERE user_id = $2', [passwordHash, userId]);

    // Mark token as used
    await db.query('UPDATE password_resets SET used = TRUE WHERE user_id = $1 AND token = $2', [userId, token]);

    console.log(`✅ Password reset successfully for user ${userId} (${email})`);

    res.json({ message: 'Password has been reset successfully. You can now log in with your new password.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Server error. Please try again later.' });
  }
});

module.exports = router;