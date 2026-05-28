const express = require('express');
const router = express.Router();
const db = require('../db');
const authMiddleware = require('../authMiddleware');

// GET /api/profile – return current user's notification_prefs
router.get('/', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT notification_prefs FROM users WHERE user_id = $1',
      [req.user.user_id]
    );
    const prefs = result.rows[0]?.notification_prefs || { email: true, push: true };
    res.json({ profile: { notification_preferences: prefs } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/profile – update notification preferences
router.post('/', authMiddleware, async (req, res) => {
  const { notification_preferences } = req.body;
  if (!notification_preferences) {
    return res.status(400).json({ error: 'Missing notification_preferences' });
  }

  try {
    await db.query(
      'UPDATE users SET notification_prefs = $1 WHERE user_id = $2',
      [notification_preferences, req.user.user_id]
    );
    res.json({ message: 'Preferences saved' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;