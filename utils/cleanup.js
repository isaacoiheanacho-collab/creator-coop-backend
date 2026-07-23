// utils/cleanup.js
const db = require('../db');

/**
 * Daily database cleanup to keep storage under 0.5GB
 */
async function dailyCleanup() {
  const startTime = Date.now();
  console.log('🧹 Starting daily database cleanup...');
  
  const results = {
    emailVerifications: 0,
    passwordResets: 0,
    userSessions: 0,
    notifications: 0,
    completedEngagements: 0,
    boostLinks: 0,
  };

  try {
    // ============================================================
    // 1. Delete expired email verifications
    // ============================================================
    const emailVerifResult = await db.query(
      `DELETE FROM email_verifications 
       WHERE expires_at < NOW() OR used = TRUE
       RETURNING id`
    );
    results.emailVerifications = emailVerifResult.rowCount || 0;
    console.log(`✅ Cleaned ${results.emailVerifications} email_verifications`);

    // ============================================================
    // 2. Delete used/expired password resets
    // ============================================================
    const passwordResetResult = await db.query(
      `DELETE FROM password_resets 
       WHERE expires_at < NOW() OR used = TRUE
       RETURNING id`
    );
    results.passwordResets = passwordResetResult.rowCount || 0;
    console.log(`✅ Cleaned ${results.passwordResets} password_resets`);

    // ============================================================
    // 3. Delete sessions older than 30 days
    // ============================================================
    const sessionResult = await db.query(
      `DELETE FROM user_sessions 
       WHERE last_active < NOW() - INTERVAL '30 days'
       RETURNING id`
    );
    results.userSessions = sessionResult.rowCount || 0;
    console.log(`✅ Cleaned ${results.userSessions} user_sessions`);

    // ============================================================
    // 4. Delete read notifications older than 30 days
    // ============================================================
    const notificationResult = await db.query(
      `DELETE FROM notifications 
       WHERE created_at < NOW() - INTERVAL '30 days' 
       AND is_read = TRUE
       RETURNING id`
    );
    results.notifications = notificationResult.rowCount || 0;
    console.log(`✅ Cleaned ${results.notifications} notifications`);

    // ============================================================
    // 5. Delete completed engagements older than 30 days
    //    Using clicked_at column (not engaged_at)
    // ============================================================
    const engagementResult = await db.query(
      `DELETE FROM completed_engagements 
       WHERE clicked_at < NOW() - INTERVAL '30 days'
       RETURNING log_id`
    );
    results.completedEngagements = engagementResult.rowCount || 0;
    console.log(`✅ Cleaned ${results.completedEngagements} completed_engagements`);

    // ============================================================
    // 6. Delete expired boosts older than 90 days
    // ============================================================
    const boostResult = await db.query(
      `DELETE FROM boost_links 
       WHERE is_expired = TRUE 
       AND created_at < NOW() - INTERVAL '90 days'
       RETURNING link_id`
    );
    results.boostLinks = boostResult.rowCount || 0;
    console.log(`✅ Cleaned ${results.boostLinks} expired boost_links`);

    // ============================================================
    // 7. VACUUM to reclaim disk space
    // ============================================================
    console.log('🔄 Running VACUUM to reclaim space...');
    await db.query('VACUUM ANALYZE');
    console.log('✅ VACUUM complete');

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ Daily cleanup complete! (${duration}s)`);
    console.log(`📊 Summary:`, results);

    return {
      success: true,
      duration: `${duration}s`,
      results,
      timestamp: new Date().toISOString()
    };

  } catch (err) {
    console.error('❌ Cleanup error:', err.message);
    return {
      success: false,
      error: err.message,
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * Get database storage statistics
 */
async function getStorageStats() {
  try {
    const result = await db.query(`
      SELECT 
        (SELECT COUNT(*) FROM users) AS total_users,
        (SELECT COUNT(*) FROM boost_links) AS total_boosts,
        (SELECT COUNT(*) FROM boost_links WHERE is_expired = FALSE) AS active_boosts,
        (SELECT COUNT(*) FROM notifications) AS total_notifications,
        (SELECT COUNT(*) FROM notifications WHERE is_read = FALSE) AS unread_notifications,
        (SELECT COUNT(*) FROM user_sessions WHERE is_active = TRUE) AS active_sessions,
        (SELECT COUNT(*) FROM completed_engagements) AS total_engagements,
        (SELECT COUNT(*) FROM completed_engagements WHERE clicked_at > NOW() - INTERVAL '30 days') AS recent_engagements
    `);
    return result.rows[0];
  } catch (err) {
    console.error('❌ Storage stats error:', err.message);
    return null;
  }
}

/**
 * Get database size
 */
async function getDatabaseSize() {
  try {
    const result = await db.query(`
      SELECT pg_database_size(current_database()) AS size_bytes
    `);
    
    const bytes = parseInt(result.rows[0].size_bytes) || 0;
    return {
      size_mb: (bytes / (1024 * 1024)).toFixed(2),
      size_gb: (bytes / (1024 * 1024 * 1024)).toFixed(4),
      size_bytes: bytes
    };
  } catch (err) {
    console.error('❌ Database size error:', err.message);
    return {
      size_mb: '0.00',
      size_gb: '0.0000',
      size_bytes: 0,
      error: err.message
    };
  }
}

module.exports = {
  dailyCleanup,
  getStorageStats,
  getDatabaseSize
};