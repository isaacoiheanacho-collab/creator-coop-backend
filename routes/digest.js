// routes/digest.js
const express = require('express');
const router = express.Router();
const db = require('../db');

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
    
    // 1. Get total verified users
    const userCountResult = await db.query(
      'SELECT COUNT(*) FROM users WHERE email_verified = TRUE'
    );
    const totalUsers = parseInt(userCountResult.rows[0].count);
    
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
        totalUsers
      });
    }

    const cohort = cohortIndex;

    console.log(`⏰ [Digest] Running for Cohort ${cohort + 1}/${totalCohorts} at ${currentHour}:00 (UK time)`);
    console.log(`📊 [Digest] Total verified users: ${totalUsers}, Cohorts: ${totalCohorts}`);

    // 4. Get users in this cohort with unengaged links
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
         AND (u.last_digest_sent IS NULL OR u.last_digest_sent < NOW() - INTERVAL '24 hours')
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
        totalUsers
      });
    }

    const userIds = cohortUsers.rows.map(u => u.user_id);
    const totalUsersNotified = cohortUsers.rows.length;
    const totalUnengagedLinks = cohortUsers.rows.reduce((sum, u) => sum + parseInt(u.unengaged_count), 0);

    console.log(`📊 [Digest] Cohort ${cohort + 1}: ${totalUsersNotified} users have ${totalUnengagedLinks} unengaged links`);

    // 5. Insert personalized notifications
    const notificationValues = [];
    const placeholders = [];
    let paramIndex = 1;

    cohortUsers.rows.forEach(({ user_id, unengaged_count }) => {
      const message = `🚀 You have ${unengaged_count} boost link(s) waiting in your feed!`;
      notificationValues.push(user_id, message);
      placeholders.push(`($${paramIndex}, $${paramIndex + 1})`);
      paramIndex += 2;
    });

    await db.query(
      `INSERT INTO notifications (user_id, message)
       VALUES ${placeholders.join(', ')}`,
      notificationValues
    );

    // 6. Update last_digest_sent for these users
    await db.query(
      `UPDATE users SET last_digest_sent = NOW() 
       WHERE user_id = ANY($1::int[])`,
      [userIds]
    );

    // 7. Send Web Push
    const sendPushNotifications = req.app.get('sendPushNotifications');
    if (sendPushNotifications && typeof sendPushNotifications === 'function') {
      const digestMessage = totalUnengagedLinks === 1
        ? `🚀 1 boost link is waiting in your feed!`
        : `🚀 ${totalUnengagedLinks} boost links are waiting in your feed!`;
      
      try {
        await sendPushNotifications(digestMessage);
        console.log(`📱 [Digest] Web push sent to Cohort ${cohort + 1} (${totalUsersNotified} users)`);
      } catch (err) {
        console.error(`❌ [Digest] Push failed:`, err.message);
      }
    }

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

// GET /api/digest/test - Test endpoint
router.get('/test', (req, res) => {
  res.json({
    success: true,
    message: 'Digest endpoint is working',
    timestamp: new Date().toISOString()
  });
});

// GET /api/digest/status - Check digest status
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
       WHERE message LIKE '%boost link%'
         AND created_at > CURRENT_DATE`
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
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;