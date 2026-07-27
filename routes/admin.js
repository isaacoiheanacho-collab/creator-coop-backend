const express = require('express');
const router = express.Router();
const db = require('../db');
const authMiddleware = require('../authMiddleware');
const cache = require('../utils/cache');

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

// ============================================================
// GET /api/admin/users - List all users
// ============================================================
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

// ============================================================
// GET /api/admin/user/:id - Get single user details
// ============================================================
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

// ============================================================
// POST /api/admin/user/:id/force-logout - Force logout a user
// ============================================================
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

// ============================================================
// POST /api/admin/user/:id/toggle-admin - Toggle admin status
// ============================================================
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

// ============================================================
// GET /api/admin/stats - Get platform stats
// ============================================================
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

// ============================================================
// POST /api/admin/trigger-digest - Manual digest trigger
// ============================================================
router.post('/trigger-digest', authMiddleware, isAdmin, async (req, res) => {
  try {
    // 1. Get total verified users
    const userCountResult = await db.query(
      'SELECT COUNT(*) FROM users WHERE email_verified = TRUE'
    );
    const totalUsers = parseInt(userCountResult.rows[0].count);

    if (totalUsers === 0) {
      return res.json({ 
        success: true, 
        message: 'No verified users to notify.',
        users_notified: 0,
        total_cohorts: 0
      });
    }

    // 2. Determine cohorts based on user count
    // ≤ 1500 → 1 cohort (Cohort 0 = ALL users)
    // > 1500 → 2 cohorts (Cohort 0 = ~50%, Cohort 1 = ~50%)
    const totalCohorts = totalUsers <= 1500 ? 1 : 2;

    // 3. Find which cohort hasn't been sent today
    let cohortToSend = null;
    let cohortCheckResults = [];

    for (let cohort = 0; cohort < totalCohorts; cohort++) {
      // Check if ANY user in this cohort has been sent today
      const checkResult = await db.query(
        `SELECT COUNT(*) FROM users 
         WHERE (user_id % $1) = $2 
           AND email_verified = TRUE 
           AND last_digest_sent = CURRENT_DATE`,
        [totalCohorts, cohort]
      );
      
      const sentCount = parseInt(checkResult.rows[0].count);
      cohortCheckResults.push({ cohort, sentCount });
      
      if (sentCount === 0) {
        cohortToSend = cohort;
        break;
      }
    }

    // 4. If all cohorts already sent today
    if (cohortToSend === null) {
      return res.json({
        success: true,
        message: `All ${totalCohorts} cohort(s) already sent today.`,
        total_users: totalUsers,
        total_cohorts: totalCohorts,
        users_notified: 0,
        cohorts: cohortCheckResults,
        timestamp: new Date().toISOString()
      });
    }

    console.log(`📊 [Admin] Sending digest to Cohort ${cohortToSend + 1}/${totalCohorts} (${totalUsers} total users)`);

    // 5. Get users in this cohort with unengaged links
    const cohortUsers = await db.query(
      `SELECT 
        u.user_id,
        COUNT(bl.link_id) AS unengaged_count
       FROM users u
       CROSS JOIN boost_links bl
       LEFT JOIN completed_engagements ce 
         ON ce.link_id = bl.link_id AND ce.user_id = u.user_id
       WHERE (u.user_id % $1) = $2
         AND bl.is_expired = FALSE
         AND ce.link_id IS NULL
         AND u.email_verified = TRUE
         AND (u.last_digest_sent IS NULL OR u.last_digest_sent < CURRENT_DATE)
       GROUP BY u.user_id
       HAVING COUNT(bl.link_id) > 0`,
      [totalCohorts, cohortToSend]
    );

    if (cohortUsers.rows.length === 0) {
      // No users with unengaged links in this cohort
      // Mark this cohort as sent anyway to prevent rechecking
      await db.query(
        `UPDATE users SET last_digest_sent = CURRENT_DATE 
         WHERE (user_id % $1) = $2 AND email_verified = TRUE`,
        [totalCohorts, cohortToSend]
      );
      
      return res.json({
        success: true,
        message: `Cohort ${cohortToSend + 1} has no users with unengaged links. Marked as sent.`,
        cohort: cohortToSend + 1,
        total_cohorts: totalCohorts,
        total_users: totalUsers,
        users_notified: 0,
        unengaged_links: 0,
        timestamp: new Date().toISOString()
      });
    }

    const userIds = cohortUsers.rows.map(u => u.user_id);
    const totalUsersNotified = cohortUsers.rows.length;
    const totalUnengagedLinks = cohortUsers.rows.reduce((sum, u) => sum + parseInt(u.unengaged_count), 0);

    console.log(`📊 [Admin] Cohort ${cohortToSend + 1}: ${totalUsersNotified} users have ${totalUnengagedLinks} unengaged links`);

    // 6. Insert personalized notifications (Batch Insert)
    const notificationValues = [];
    const placeholders = [];
    let paramIndex = 1;

    cohortUsers.rows.forEach(({ user_id, unengaged_count }) => {
      const message = unengaged_count === 1
        ? `🚀 You have 1 unengaged feed waiting!`
        : `🚀 You have ${unengaged_count} unengaged feeds waiting!`;
      
      notificationValues.push(user_id, message);
      placeholders.push(`($${paramIndex}, $${paramIndex + 1})`);
      paramIndex += 2;
    });

    await db.query(
      `INSERT INTO notifications (user_id, message)
       VALUES ${placeholders.join(', ')}`,
      notificationValues
    );

    // 7. Update last_digest_sent for these users
    await db.query(
      `UPDATE users SET last_digest_sent = CURRENT_DATE 
       WHERE user_id = ANY($1::int[])`,
      [userIds]
    );

    // 8. Send Web Push to this cohort
    const sendPushNotifications = req.app.get('sendPushNotifications');
    let pushSent = false;
    if (sendPushNotifications && typeof sendPushNotifications === 'function') {
      try {
        const digestMessage = totalUnengagedLinks === 1
          ? `🚀 1 unengaged feed is waiting for you!`
          : `🚀 ${totalUnengagedLinks} unengaged feeds are waiting for you!`;
        await sendPushNotifications(digestMessage);
        pushSent = true;
        console.log(`📱 [Admin] Web push sent to Cohort ${cohortToSend + 1} (${totalUsersNotified} users)`);
      } catch (err) {
        console.error(`❌ [Admin] Push failed:`, err.message);
      }
    }

    // 9. Invalidate notification cache
    await cache.invalidateCache('notifications:*');

    res.json({
      success: true,
      cohort: cohortToSend + 1,
      total_cohorts: totalCohorts,
      total_users: totalUsers,
      users_notified: totalUsersNotified,
      unengaged_links: totalUnengagedLinks,
      push_sent: pushSent,
      message: `Cohort ${cohortToSend + 1}/${totalCohorts} sent successfully.`,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error('❌ [Admin] Digest error:', err.message);
    console.error('Stack:', err.stack);
    res.status(500).json({ 
      success: false,
      error: err.message,
      timestamp: new Date().toISOString()
    });
  }
});

module.exports = router;