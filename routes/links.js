const express = require('express');
const router = express.Router();
const db = require('../db');
const authMiddleware = require('../authMiddleware');
const cache = require('../utils/cache');
const { cleanUrl, hasTrackingParams } = require('../utils/urlCleaner');

const EXPIRATION_THRESHOLD_PERCENTAGE = 0.95; // 95% of active users must engage

// ============================================================
// POST /api/links/boost – one post per rolling 24 hours
// ============================================================
router.post('/boost', authMiddleware, async (req, res) => {
  const { link_url } = req.body;
  const { user_id } = req.user;

  if (!link_url) {
    return res.status(400).json({ error: 'Please provide a valid content link URL.' });
  }

  // ✅ Clean the URL - remove tracking parameters
  const sanitizedUrl = cleanUrl(link_url);
  
  // Log if tracking params were found (for monitoring)
  if (hasTrackingParams(link_url)) {
    console.log(`🔍 [UrlCleaner] Removed tracking params from: ${sanitizedUrl}`);
  }

  try {
    // ============================================================
    // 1. Check active subscription (with feature flag)
    // ============================================================
    const SUBSCRIPTION_REQUIRED = process.env.SUBSCRIPTION_REQUIRED === 'true';

    if (SUBSCRIPTION_REQUIRED) {
      // Subscription is required - check database
      const subCheck = await db.query(
        `SELECT status FROM subscriptions
         WHERE user_id = $1 AND status = 'active' AND expires_at > NOW()`,
        [user_id]
      );
      if (subCheck.rows.length === 0) {
        return res.status(402).json({ error: 'Active subscription required to post a boost link.' });
      }
    }
    // ✅ FREE MODE: Skip subscription check when SUBSCRIPTION_REQUIRED = false

    // 2. 24‑hour cooldown (rolling window)
    const lastPost = await db.query(
      `SELECT created_at FROM boost_links
       WHERE creator_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [user_id]
    );
    if (lastPost.rows.length > 0) {
      const lastDate = new Date(lastPost.rows[0].created_at);
      const now = new Date();
      const hoursDiff = (now - lastDate) / (1000 * 60 * 60);
      if (hoursDiff < 24) {
        const remaining = Math.ceil(24 - hoursDiff);
        return res.status(429).json({
          error: `You can post only once every 24 hours. Please wait ${remaining} hour(s).`
        });
      }
    }

    // 3. Insert new link with cleaned URL
    const newLink = await db.query(
      `INSERT INTO boost_links (creator_id, link_url)
       VALUES ($1, $2)
       RETURNING link_id, creator_id, link_url, created_at`,
      [user_id, sanitizedUrl]
    );

    // Get creator username (needed for notifications)
    const creatorResult = await db.query(
      'SELECT username FROM users WHERE user_id = $1',
      [user_id]
    );
    const creatorName = creatorResult.rows[0]?.username || 'Someone';

    // ============================================================
    // 4. BATCH NOTIFICATIONS - OPTIMIZED (Single SQL, no JS loop)
    // ============================================================
    try {
      await db.query(
        `INSERT INTO notifications (user_id, link_id, creator_id, creator_name, message)
         SELECT user_id, $1, $2, $3, $4
         FROM users
         WHERE user_id != $2`,
        [newLink.rows[0].link_id, user_id, creatorName, `${creatorName} shared a new boost! 🚀`]
      );
      console.log(`📝 Batch notifications saved for all users about ${creatorName}'s boost`);
    } catch (dbError) {
      console.error('Failed to save notifications to database:', dbError);
    }

    // ============================================================
    // 5. REAL-TIME SOCKET NOTIFICATION (for currently online users)
    // ============================================================
    try {
      const io = req.app.get('io');
      const activeUsers = req.app.get('activeUsers');

      let notifiedCount = 0;
      const activeUserIds = Array.from(activeUsers.keys());
      
      activeUserIds.forEach(userId => {
        const socketId = activeUsers.get(userId);
        if (socketId) {
          io.to(socketId).emit('new-boost', {
            creator: creatorName,
            link_id: newLink.rows[0].link_id,
            message: `${creatorName} just shared a new boost! 🚀`,
            timestamp: new Date().toISOString()
          });
          notifiedCount++;
        }
      });

      console.log(`📢 Real-time notification sent to ${notifiedCount} active users`);
    } catch (socketError) {
      console.error('Socket notification error:', socketError);
    }

    // Invalidate feed caches for all users (since new boost is available)
    await cache.invalidateCache('feed:*');

    res.status(201).json({
      message: 'Your boost link has been added to the cooperative loop!',
      boost: newLink.rows[0]
    });

  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error during link submission.' });
  }
});

// ============================================================
// GET /api/links/notifications – get unread notifications
// ============================================================
router.get('/notifications', authMiddleware, async (req, res) => {
  try {
    const cacheKey = `notifications:${req.user.user_id}`;
    
    // Try cache first
    const cached = await cache.getCached(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    // Cache miss - query database
    const result = await db.query(
      `SELECT id, message, link_id, created_at, is_read, creator_name
       FROM notifications
       WHERE user_id = $1 AND is_read = FALSE
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.user.user_id]
    );

    const response = {
      notifications: result.rows,
      count: result.rows.length
    };

    // Cache for 30 seconds
    await cache.setCached(cacheKey, response, cache.CACHE_TTL.NOTIFICATIONS);
    
    res.json(response);
  } catch (err) {
    console.error('Get notifications error:', err);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// ============================================================
// POST /api/links/notifications/read – mark notification as read
// ============================================================
router.post('/notifications/read', authMiddleware, async (req, res) => {
  const { notification_id } = req.body;
  
  if (!notification_id) {
    return res.status(400).json({ error: 'notification_id is required' });
  }

  try {
    await db.query(
      'UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2',
      [notification_id, req.user.user_id]
    );
    
    // Invalidate notifications cache
    await cache.invalidateCache(`notifications:${req.user.user_id}`);
    
    res.json({ message: 'Notification marked as read' });
  } catch (err) {
    console.error('Mark notification read error:', err);
    res.status(500).json({ error: 'Failed to mark notification as read' });
  }
});

// ============================================================
// POST /api/links/notifications/read-all – mark all as read
// ============================================================
router.post('/notifications/read-all', authMiddleware, async (req, res) => {
  try {
    await db.query(
      'UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE',
      [req.user.user_id]
    );
    
    // Invalidate notifications cache
    await cache.invalidateCache(`notifications:${req.user.user_id}`);
    
    res.json({ message: 'All notifications marked as read' });
  } catch (err) {
    console.error('Mark all read error:', err);
    res.status(500).json({ error: 'Failed to mark all notifications as read' });
  }
});

// ============================================================
// GET /api/links/last-post – fetch last post time for cooldown display
// ============================================================
router.get('/last-post', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT created_at FROM boost_links
       WHERE creator_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [req.user.user_id]
    );
    if (result.rows.length === 0) {
      return res.json({ lastPost: null });
    }
    res.json({ lastPost: result.rows[0].created_at });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// GET /api/links/feed – show active tasks with pagination (OPTIMIZED)
// ============================================================
router.get('/feed', authMiddleware, async (req, res) => {
  const { user_id } = req.user;
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const offset = (page - 1) * limit;

  try {
    const cacheKey = `feed:${user_id}:page:${page}:limit:${limit}`;
    
    // Try cache first
    const cached = await cache.getCached(cacheKey);
    if (cached) {
      return res.status(200).json(cached);
    }

    // OPTIMIZED: Use LEFT JOIN instead of NOT IN subquery
    const feedQuery = await db.query(
      `SELECT bl.link_id, bl.link_url, bl.created_at, u.username AS creator_username
       FROM boost_links bl
       JOIN users u ON bl.creator_id = u.user_id
       LEFT JOIN completed_engagements ce 
              ON ce.link_id = bl.link_id AND ce.user_id = $1
       WHERE bl.is_expired = FALSE
         AND bl.creator_id != $1
         AND ce.link_id IS NULL
       ORDER BY bl.created_at ASC
       LIMIT $2 OFFSET $3`,
      [user_id, limit, offset]
    );

    // Get total count for pagination metadata
    const countResult = await db.query(
      `SELECT COUNT(*) FROM boost_links bl
       LEFT JOIN completed_engagements ce 
              ON ce.link_id = bl.link_id AND ce.user_id = $1
       WHERE bl.is_expired = FALSE
         AND bl.creator_id != $1
         AND ce.link_id IS NULL`,
      [user_id]
    );

    const total = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(total / limit);

    const response = {
      message: 'Active tasks fetched successfully.',
      count: feedQuery.rows.length,
      total: total,
      page: page,
      limit: limit,
      totalPages: totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
      feed: feedQuery.rows
    };

    // Cache for 1 minute
    await cache.setCached(cacheKey, response, cache.CACHE_TTL.BOOST_FEED);

    res.status(200).json(response);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error while generating task feed.' });
  }
});

// ============================================================
// POST /api/links/engage – atomic engagement + expiry check
// ============================================================
router.post('/engage', authMiddleware, async (req, res) => {
  const { link_id } = req.body;
  const { user_id } = req.user;

  if (!link_id) {
    return res.status(400).json({ error: 'Please provide a valid link_id.' });
  }

  try {
    // Prevent double engagement
    const duplicate = await db.query(
      'SELECT 1 FROM completed_engagements WHERE user_id = $1 AND link_id = $2',
      [user_id, link_id]
    );
    if (duplicate.rows.length > 0) {
      return res.status(400).json({ error: 'You have already engaged with this link.' });
    }

    await db.query('BEGIN');

    // Record engagement
    await db.query(
      'INSERT INTO completed_engagements (user_id, link_id) VALUES ($1, $2)',
      [user_id, link_id]
    );

    // Get total active users
    const userCount = await db.query("SELECT COUNT(*) FROM users");
    const totalActiveUsers = parseInt(userCount.rows[0].count);
    const targetClicks = Math.max(1, Math.round(totalActiveUsers * EXPIRATION_THRESHOLD_PERCENTAGE));

    // Increment clicks and mark expired if threshold reached
    const updateResult = await db.query(
      `UPDATE boost_links
       SET clicks_received = clicks_received + 1,
           is_expired = CASE WHEN clicks_received + 1 >= $1 THEN TRUE ELSE FALSE END
       WHERE link_id = $2
       RETURNING clicks_received, is_expired`,
      [targetClicks, link_id]
    );

    await db.query('COMMIT');

    // Invalidate feed cache for this user
    await cache.invalidateCache(`feed:${user_id}:*`);

    res.status(200).json({
      message: 'Engagement registered successfully!',
      metrics: {
        clicks_received: updateResult.rows[0].clicks_received,
        is_expired: updateResult.rows[0].is_expired,
        target_clicks_needed: targetClicks
      }
    });
  } catch (err) {
    await db.query('ROLLBACK');
    console.error(err.message);
    res.status(500).json({ error: 'Server error during engagement logging.' });
  }
});

module.exports = router;