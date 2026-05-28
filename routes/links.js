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
    return res.status(400).json({ error: 'Please provide a valid Facebook content link URL.' });
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

    res.status(201).json({
      message: 'Your boost link has been added to the cooperative loop!',
      boost: newLink.rows[0]
    });

  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error during link submission.' });
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