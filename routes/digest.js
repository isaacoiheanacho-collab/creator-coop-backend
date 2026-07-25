// routes/digest.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const cache = require('../utils/cache');

const CRON_SECRET = process.env.CRON_SECRET || 'your-super-secret-key-here';

// POST /api/digest/trigger - Called by external webhook (cron-job.org)
router.post('/trigger', async (req, res) => {
  // Verify secret key
  if (req.headers['x-cron-secret'] !== CRON_SECRET) {
    console.warn('❌ [Digest] Unauthorized attempt from:', req.ip);
    return res.status(403).json({ error: 'Unauthorized' });
  }

  try {
    // Get current hour in UK time
    const currentHour = parseInt(
      new Date().toLocaleString('en-GB', { 
        timeZone: 'Europe/London', 
        hour: '2-digit',
        hour12: false 
      })
    );
    
    // ============================================================
    // SIMPLIFIED HYBRID COHORT LOGIC - 1 or 2 Cohorts
    // ============================================================
    
    // 1. Get total verified users (cached)
    const cacheKey = 'digest:user_count';
    let totalUsers = await cache.getCached(cacheKey);
    
    if (!totalUsers) {
      const userCountResult = await db.query(
        'SELECT COUNT(*) FROM users WHERE email_verified = TRUE'
      );
      totalUsers = parseInt(userCountResult.rows[0].count);
      await cache.setCached(cacheKey, totalUsers, 3600); // Cache for 1 hour
    }
    
    // 2. Determine number of cohorts based on user count
    let totalCohorts;
    let productiveHours;
    
    if (totalUsers <= 1500) {
      // Small user base: 1 cohort at 10:00 AM
      totalCohorts = 1;
      productiveHours = [10]; // 10:00 AM only
    } else {
      // Large user base: 2 cohorts at 10AM and 4PM
      totalCohorts = 2;
      productiveHours = [10, 16]; // 10:00 AM, 4:00 PM
    }
    
    // 3. Check if current hour is a scheduled digest hour
    const cohortIndex = productiveHours.indexOf(currentHour);
    
    if (cohortIndex === -1) {
      // Not a scheduled hour - skip silently
      return res.json({ 
        message: 'Not a scheduled digest hour', 
        currentHour,
        scheduledHours: productiveHours,
        totalCohorts,
        totalUsers,
        timestamp: new Date().toISOString()
      });
    }

    const cohort = cohortIndex;

    console.log(`⏰ [Digest] Running for Cohort ${cohort + 1}/${totalCohorts} at ${currentHour}:00 (UK time)`);
    console.log(`📊 [Digest] Total verified users: ${totalUsers}, Cohorts: ${totalCohorts}`);

    // ============================================================
    // 4. GET PERSONALIZED UNENGAGED COUNT FOR EACH USER IN COHORT
    // ============================================================
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
      [totalCohorts, cohort]
    );

    if (cohortUsers.rows.length === 0) {
      console.log(`ℹ️ [Digest] No users in Cohort ${cohort + 1} have unengaged links.`);
      return res.json({ 
        message: 'No users with unengaged links', 
        cohort: cohort + 1,
        users: 0,
        totalCohorts,
        totalUsers,
        timestamp: new Date().toISOString()
      });
    }

    const userIds = cohortUsers.rows.map(u => u.user_id);
    const totalUsersNotified = cohortUsers.rows.length;
    const totalUnengagedLinks = cohortUsers.rows.reduce((sum, u) => sum + parseInt(u.unengaged_count), 0);

    console.log(`📊 [Digest] Cohort ${cohort + 1}: ${totalUsersNotified} users have ${totalUnengagedLinks} unengaged links`);

    // ============================================================
    // 5. INSERT PERSONALIZED NOTIFICATIONS (Batch Insert)
    // ============================================================
    const notificationValues = [];
    const placeholders = [];
    let paramIndex = 1;

    cohortUsers.rows.forEach(({ user_id, unengaged_count }) => {
      // ✅ Personalized message with exact unengaged count
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

    // ============================================================
    // 6. UPDATE last_digest_sent FOR THESE USERS
    // ============================================================
    await db.query(
      `UPDATE users SET last_digest_sent = CURRENT_DATE 
       WHERE user_id = ANY($1::int[])`,
      [userIds]
    );

    // ============================================================
    // 7. SEND WEB PUSH TO THIS COHORT ONLY
    // ============================================================
    const sendPushNotifications = req.app.get('sendPushNotifications');
    if (sendPushNotifications && typeof sendPushNotifications === 'function') {
      // Generic push message (the personalized count is in the notification)
      const digestMessage = totalUnengagedLinks === 1
        ? `🚀 1 unengaged feed is waiting for you!`
        : `🚀 ${totalUnengagedLinks} unengaged feeds are waiting for you!`;
      
      try {
        await sendPushNotifications(digestMessage);
        console.log(`📱 [Digest] Web push sent to Cohort ${cohort + 1} (${totalUsersNotified} users)`);
      } catch (err) {
        console.error(`❌ [Digest] Push failed:`, err.message);
      }
    }

    // ============================================================
    // 8. INVALIDATE NOTIFICATION CACHE
    // ============================================================
    await cache.invalidateCache('notifications:*');

    res.json({
      success: true,
      cohort: cohort + 1,
      totalCohorts,
      totalUsers,
      users_notified: totalUsersNotified,
      unengaged_links: totalUnengagedLinks,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error('❌ [Digest Error]:', err.message);
    console.error('Stack:', err.stack);
    res.status(500).json({ 
      error: err.message,
      timestamp: new Date().toISOString()
    });
  }
});

// ============================================================
// GET /api/digest/test - Test endpoint
// ============================================================
router.get('/test', (req, res) => {
  res.json({
    success: true,
    message: 'Digest endpoint is working',
    timestamp: new Date().toISOString()
  });
});

// ============================================================
// GET /api/digest/status - Check digest status
// ============================================================
router.get('/status', async (req, res) => {
  try {
    const userCount = await db.query(
      'SELECT COUNT(*) FROM users WHERE email_verified = TRUE'
    );
    const totalUsers = parseInt(userCount.rows[0].count);
    
    const totalCohorts = totalUsers <= 1500 ? 1 : 2;
    const productiveHours = totalUsers <= 1500 ? [10] : [10, 16];
    
    // Get last digest run
    const lastRun = await db.query(
      `SELECT 
        MAX(created_at) AS last_run,
        COUNT(*) AS total_sent_today
       FROM notifications 
       WHERE message LIKE '%unengaged feed%'
         AND created_at > CURRENT_DATE`
    );
    
    // Get unengaged count distribution
    const distribution = await db.query(
      `SELECT 
        COUNT(*) AS total_users,
        SUM(CASE WHEN unengaged_count > 0 THEN 1 ELSE 0 END) AS users_with_unengaged
       FROM (
         SELECT 
           u.user_id,
           COUNT(bl.link_id) AS unengaged_count
         FROM users u
         CROSS JOIN boost_links bl
         LEFT JOIN completed_engagements ce 
           ON ce.link_id = bl.link_id AND ce.user_id = u.user_id
         WHERE bl.is_expired = FALSE
           AND ce.link_id IS NULL
           AND u.email_verified = TRUE
         GROUP BY u.user_id
       ) AS counts`
    );
    
    res.json({
      status: 'ok',
      totalUsers,
      config: {
        totalCohorts,
        hours: productiveHours,
        description: totalUsers <= 1500 
          ? '1 cohort at 10:00 AM' 
          : '2 cohorts at 10:00 AM and 4:00 PM'
      },
      lastRun: lastRun.rows[0]?.last_run || null,
      sentToday: parseInt(lastRun.rows[0]?.total_sent_today || 0),
      unengagedStats: {
        total_users: parseInt(distribution.rows[0]?.total_users || 0),
        users_with_unengaged: parseInt(distribution.rows[0]?.users_with_unengaged || 0)
      },
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;