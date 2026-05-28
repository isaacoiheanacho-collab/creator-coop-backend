const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const jwt = require('jsonwebtoken');
const authMiddleware = require('../authMiddleware');

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
    // No slot calculation – just insert
    const newUser = await db.query(
      `INSERT INTO users (username, email, password_hash, facebook_profile_url)
       VALUES ($1, $2, $3, $4)
       RETURNING user_id, username, email, facebook_profile_url`,
      [username, email, passwordHash, facebook_profile_url]
    );
    res.status(201).json({
      message: 'Registration successful!',
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
    // JWT now only contains user_id (no slot)
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

// GET /api/auth/me
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const userRes = await db.query(
      'SELECT user_id, username, email, facebook_profile_url FROM users WHERE user_id = $1',
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
    res.json({
      user: userRes.rows[0],
      subscription_active
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

module.exports = router;