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
    const currentHour = new Date().getHours();
    const totalCohorts = 6;
    
    // Map to 6 productive hours: 8AM, 10AM, 12PM, 2PM, 4PM, 6PM
    const productiveHours = [8, 10, 12, 14, 16, 18];
    const cohortIndex = productiveHours.indexOf(currentHour);
    
    if (cohortIndex === -1) {
      // Not a scheduled hour - skip silently
      return res.json({ 
        message: 'Not a scheduled digest hour', 
        currentHour,
        scheduledHours: productiveHours 
      });
    }

    const cohort = cohortIndex;

    console.log(`⏰ [Digest] Running for Cohort ${cohort} at ${currentHour}:00`);

    // 1. Get users in this cohort with unengaged links
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
      console.log(`ℹ️ [Digest] No users in Cohort ${cohort} have unengaged links.`);
      return res.json({ 
        message: 'No users with unengaged links', 
        cohort, 
        users: 0 
      });
    }

    const userIds = cohortUsers.rows.map(u => u.user_id);
    const totalUsers = cohortUsers.rows.length;
    const totalUnengagedLinks = cohortUsers.rows.reduce((sum, u) => sum + parseInt(u.unengaged_count), 0);

    console.log(`📊 [Digest] Cohort ${cohort}: ${totalUsers} users have ${totalUnengagedLinks} unengaged links`);

    // 2. Insert personalized notifications
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

    // 3. Update last_digest_sent for these users
    await db.query(
      `UPDATE users SET last_digest_sent = NOW() 
       WHERE user_id = ANY($1::int[])`,
      [userIds]
    );

    // 4. Send Web Push (get from app)
    const sendPushNotifications = req.app.get('sendPushNotifications');
    if (sendPushNotifications && typeof sendPushNotifications === 'function') {
      const digestMessage = totalUnengagedLinks === 1
        ? `🚀 1 boost link is waiting in your feed!`
        : `🚀 ${totalUnengagedLinks} boost links are waiting in your feed!`;
      
      try {
        await sendPushNotifications(digestMessage);
        console.log(`📱 [Digest] Web push sent to Cohort ${cohort} (${totalUsers} users)`);
      } catch (err) {
        console.error(`❌ [Digest] Push failed:`, err.message);
      }
    }

    res.json({
      success: true,
      cohort,
      users: totalUsers,
      unengaged_links: totalUnengagedLinks,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error('❌ [Digest Error]:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;