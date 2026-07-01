const express = require('express');
const router = express.Router();
const db = require('../db');
const authMiddleware = require('../authMiddleware');

// Middleware to check if user is admin
const isAdmin = async (req, res, next) => {
  try {
    const result = await db.query(
      'SELECT is_admin FROM users WHERE user_id = $1',
      [req.user.user_id]
    );
    if (result.rows.length === 0 || !result.rows[0].is_admin) {
      return res.status(403).json({ error: 'Admin access required.' });
    }
    next();
  } catch (err) {
    console.error('Admin check error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
};

// GET /api/admin/users - List all users
router.get('/users', authMiddleware, isAdmin, async (req, res) => {
  try {
    const users = await db.query(`
      SELECT 
        u.user_id, u.username, u.email, u.social_profile_url, u.country, u.phone,
        u.created_at, u.email_verified, u.is_admin,
        s.status AS subscription_status, s.expires_at AS subscription_expiry,
        COUNT(DISTINCT bl.link_id) AS total_boosts,
        COALESCE(SUM(bl.clicks_received), 0) AS total_engagements,
        (SELECT COUNT(*) FROM user_sessions WHERE user_id = u.user_id AND is_active = TRUE) AS active_sessions
      FROM users u
      LEFT JOIN subscriptions s ON u.user_id = s.user_id AND s.status = 'active' AND s.expires_at > NOW()
      LEFT JOIN boost_links bl ON u.user_id = bl.creator_id
      GROUP BY u.user_id, s.status, s.expires_at
      ORDER BY u.created_at DESC
    `);
    res.json({ users: users.rows });
  } catch (err) {
    console.error('Admin users error:', err);
    res.status(500).json({ error: 'Failed to fetch users.' });
  }
});

// GET /api/admin/user/:id - Get single user details
router.get('/user/:id', authMiddleware, isAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const user = await db.query(`
      SELECT 
        u.user_id, u.username, u.email, u.social_profile_url, u.country, u.phone,
        u.created_at, u.email_verified, u.is_admin, u.social_links,
        s.status AS subscription_status, s.expires_at AS subscription_expiry
      FROM users u
      LEFT JOIN subscriptions s ON u.user_id = s.user_id AND s.status = 'active' AND s.expires_at > NOW()
      WHERE u.user_id = $1
    `, [userId]);
    
    if (user.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    
    // Get user's boosts
    const boosts = await db.query(`
      SELECT link_id, link_url, clicks_received, is_expired, created_at
      FROM boost_links
      WHERE creator_id = $1
      ORDER BY created_at DESC
      LIMIT 50
    `, [userId]);
    
    // Get user's sessions
    const sessions = await db.query(`
      SELECT id, device_info, ip_address, created_at, last_active, is_active
      FROM user_sessions
      WHERE user_id = $1
      ORDER BY created_at DESC
    `, [userId]);
    
    res.json({
      user: user.rows[0],
      boosts: boosts.rows,
      sessions: sessions.rows
    });
  } catch (err) {
    console.error('Admin user detail error:', err);
    res.status(500).json({ error: 'Failed to fetch user details.' });
  }
});

// POST /api/admin/user/:id/force-logout - Force logout a user
router.post('/user/:id/force-logout', authMiddleware, isAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    await db.query(
      'UPDATE user_sessions SET is_active = FALSE WHERE user_id = $1',
      [userId]
    );
    res.json({ message: 'User logged out from all devices.' });
  } catch (err) {
    console.error('Force logout error:', err);
    res.status(500).json({ error: 'Failed to force logout.' });
  }
});

// POST /api/admin/user/:id/toggle-admin - Toggle admin status
router.post('/user/:id/toggle-admin', authMiddleware, isAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    
    // Don't allow removing your own admin
    if (parseInt(userId) === req.user.user_id) {
      return res.status(400).json({ error: 'Cannot modify your own admin status.' });
    }
    
    const result = await db.query(
      'UPDATE users SET is_admin = NOT is_admin WHERE user_id = $1 RETURNING is_admin',
      [userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    
    res.json({ 
      message: `Admin status updated.`, 
      is_admin: result.rows[0].is_admin 
    });
  } catch (err) {
    console.error('Toggle admin error:', err);
    res.status(500).json({ error: 'Failed to toggle admin status.' });
  }
});

// GET /api/admin/stats - Get platform stats
router.get('/stats', authMiddleware, isAdmin, async (req, res) => {
  try {
    const stats = await db.query(`
      SELECT 
        (SELECT COUNT(*) FROM users) AS total_users,
        (SELECT COUNT(*) FROM users WHERE email_verified = TRUE) AS verified_users,
        (SELECT COUNT(*) FROM users WHERE is_admin = TRUE) AS admin_count,
        (SELECT COUNT(*) FROM boost_links) AS total_boosts,
        (SELECT COUNT(*) FROM boost_links WHERE is_expired = FALSE) AS active_boosts,
        (SELECT COALESCE(SUM(clicks_received), 0) FROM boost_links) AS total_engagements,
        (SELECT COUNT(*) FROM user_sessions WHERE is_active = TRUE) AS active_sessions,
        (SELECT COUNT(*) FROM subscriptions WHERE status = 'active' AND expires_at > NOW()) AS active_subscriptions
    `);
    res.json(stats.rows[0]);
  } catch (err) {
    console.error('Admin stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats.' });
  }
});

module.exports = router;