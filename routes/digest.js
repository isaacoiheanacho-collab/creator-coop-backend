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
    // ✅ Get current hour in UK time (Europe/London)
    const currentHour = parseInt(
      new Date().toLocaleString('en-GB', { 
        timeZone: 'Europe/London', 
        hour: '2-digit',
        hour12: false 
      })
    );
    
    // ============================================================
    // HYBRID COHORT LOGIC - Dynamic sizing based on user count
    // ============================================================
    
    // 1. Get total verified users
    const userCountResult = await db.query(
      'SELECT COUNT(*) FROM users WHERE email_verified = TRUE'
    );
    const totalUsers = parseInt(userCountResult.rows[0].count);
    
    // 2. Determine number of cohorts based on user count
    let totalCohorts;
    let productiveHours;
    
    if (totalUsers <= 500) {
      // Small user base: 1 cohort at 10:00 AM
      totalCohorts = 1;
      productiveHours = [10];
    } else if (totalUsers <= 1500) {
      // Medium user base: 3 cohorts at 10AM, 2PM, 6PM
      totalCohorts = 3;
      productiveHours = [10, 14, 18];
    } else {
      // Large user base: 6 cohorts at 8AM, 10AM, 12PM, 2PM, 4PM, 6PM
      totalCohorts = 6;
      productiveHours = [8, 10, 12, 14, 16, 18];
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

    console.log(`⏰ [Digest] Running for Cohort ${cohort} (${totalCohorts} total cohorts) at ${currentHour}:00 (UK time)`);
    console.log(`📊 [Digest] Total verified users: ${totalUsers}, Cohorts: ${totalCohorts}`);

    // ============================================================
    // 4. Get users in this cohort
    //    Each user is assigned to ONE cohort based on their ID
    //    User ID % totalCohorts = cohort assignment
    // ============================================================
    const cohortUsers = await db.query(
      `SELECT 
        u.user_id
       FROM users u
       WHERE (u.user_id % $1) = $2
         AND u.email_verified = TRUE
         AND (u.last_digest_sent IS NULL OR u.last_digest_sent < NOW() - INTERVAL '24 hours')`,
      [totalCohorts, cohort]
    );

    if (cohortUsers.rows.length === 0) {
      console.log(`ℹ️ [Digest] No users in Cohort ${cohort} need a reminder today.`);
      return res.json({ 
        message: 'No users need a reminder', 
        cohort, 
        users: 0,
        totalCohorts,
        totalUsers
      });
    }

    const userIds = cohortUsers.rows.map(u => u.user_id);
    const totalUsersNotified = cohortUsers.rows.length;

    console.log(`📊 [Digest] Cohort ${cohort}: ${totalUsersNotified} users will receive a reminder`);

    // ============================================================
    // 5. Insert personalized daily reminder notifications
    // ============================================================
    const notificationValues = [];
    const placeholders = [];
    let paramIndex = 1;

    cohortUsers.rows.forEach(({ user_id }) => {
      // Daily reminder message - consistent for all users
      const message = `🌞 Daily Reminder: Check your feed for new boost links!`;
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
    // 6. Update last_digest_sent for these users
    //    Prevents them from getting another reminder for 24 hours
    // ============================================================
    await db.query(
      `UPDATE users SET last_digest_sent = NOW() 
       WHERE user_id = ANY($1::int[])`,
      [userIds]
    );

    // ============================================================
    // 7. Send Web Push Notification
    // ============================================================
    const sendPushNotifications = req.app.get('sendPushNotifications');
    if (sendPushNotifications && typeof sendPushNotifications === 'function') {
      const digestMessage = `🌞 Daily Reminder: Check your feed for new boost links!`;
      
      try {
        await sendPushNotifications(digestMessage);
        console.log(`📱 [Digest] Web push sent to Cohort ${cohort} (${totalUsersNotified} users)`);
      } catch (err) {
        console.error(`❌ [Digest] Push failed:`, err.message);
      }
    }

    res.json({
      success: true,
      cohort,
      totalCohorts,
      totalUsers,
      users_notified: totalUsersNotified,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error('❌ [Digest Error]:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;