const express = require('express');
const router = express.Router();
const db = require('../db');
const authMiddleware = require('../authMiddleware');

const EXPIRATION_THRESHOLD_PERCENTAGE = 0.95; // 95% of active users must engage

// POST /api/links/boost – one post per rolling 24 hours
router.post('/boost', authMiddleware, async (req, res) => {
  const { link_url } = req.body;
  const { user_id } = req.user;

  if (!link_url) {
    return res.status(400).json({ error: 'Please provide a valid content link URL.' });
  }

  try {
    // 1. Check active subscription
    const subCheck = await db.query(
      `SELECT status FROM subscriptions
       WHERE user_id = $1 AND status = 'active' AND expires_at > NOW()`,
      [user_id]
    );
    if (subCheck.rows.length === 0) {
      return res.status(402).json({ error: 'Active subscription required to post a boost link.' });
    }

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

    // 3. Insert new link
    const newLink = await db.query(
      `INSERT INTO boost_links (creator_id, link_url)
       VALUES ($1, $2)
       RETURNING link_id, creator_id, link_url, created_at`,
      [user_id, link_url]
    );

    // ============================================================
    // 4. SAVE NOTIFICATION TO DATABASE (for offline users)
    // ============================================================
    try {
      // Get creator username
      const creatorResult = await db.query(
        'SELECT username FROM users WHERE user_id = $1',
        [user_id]
      );
      const creatorName = creatorResult.rows[0]?.username || 'Someone';

      // Get all users except the creator
      const allUsers = await db.query(
        'SELECT user_id FROM users WHERE user_id != $1',
        [user_id]
      );

      // Insert notification for each user
      for (const user of allUsers.rows) {
        await db.query(
          `INSERT INTO notifications (user_id, link_id, creator_id, creator_name, message)
           VALUES ($1, $2, $3, $4, $5)`,
          [user.user_id, newLink.rows[0].link_id, user_id, creatorName, `${creatorName} shared a new boost! 🚀`]
        );
      }

      console.log(`📝 Notifications saved for ${allUsers.rows.length} users about ${creatorName}'s boost`);

      // ============================================================
      // 5. REAL-TIME NOTIFICATION (for online users)
      // ============================================================
      try {
        const io = req.app.get('io');
        const activeUsers = req.app.get('activeUsers');

        let notifiedCount = 0;

        allUsers.rows.forEach(user => {
          const socketId = activeUsers.get(user.user_id);
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
        // Don't fail the boost submission if socket notification fails
      }

    } catch (notifError) {
      console.error('Notification error:', notifError);
      // Don't fail the boost submission if notification fails
    }

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
    const result = await db.query(
      `SELECT id, message, link_id, created_at, is_read, creator_name
       FROM notifications
       WHERE user_id = $1 AND is_read = FALSE
       ORDER BY created_at DESC`,
      [req.user.user_id]
    );
    res.json({ 
      notifications: result.rows, 
      count: result.rows.length 
    });
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
    res.json({ message: 'All notifications marked as read' });
  } catch (err) {
    console.error('Mark all read error:', err);
    res.status(500).json({ error: 'Failed to mark all notifications as read' });
  }
});

// GET /api/links/last-post – fetch last post time for cooldown display
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

// GET /api/links/feed – show active tasks with creator username
router.get('/feed', authMiddleware, async (req, res) => {
  const { user_id } = req.user;

  try {
    const feedQuery = await db.query(
      `SELECT bl.link_id, bl.link_url, bl.created_at, u.username AS creator_username
       FROM boost_links bl
       JOIN users u ON bl.creator_id = u.user_id
       WHERE bl.is_expired = FALSE
         AND bl.creator_id != $1
         AND bl.link_id NOT IN (
             SELECT link_id FROM completed_engagements WHERE user_id = $1
         )
       ORDER BY bl.created_at ASC`,
      [user_id]
    );

    res.status(200).json({
      message: 'Active tasks fetched successfully.',
      count: feedQuery.rows.length,
      feed: feedQuery.rows
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error while generating task feed.' });
  }
});

// POST /api/links/engage – atomic engagement + expiry check
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