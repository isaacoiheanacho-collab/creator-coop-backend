const express = require('express');
const router = express.Router();
const db = require('../db');
const authMiddleware = require('../authMiddleware');

// Helper function to map the current server hour (0-23) to the slot ID
const getCurrentSystemSlotId = () => {
  return new Date().getHours();
};

// @route   POST /api/links/boost
// @desc    Gated link submission—Allows creators to post based on an exact integer slot division rule
// @access  Private (Protected by authMiddleware)
router.post('/boost', authMiddleware, async (req, res) => {
  const { link_url } = req.body;
  const { user_id, assigned_slot_id } = req.user; // Decoded from token

  if (!link_url) {
    return res.status(400).json({ error: 'Please provide a valid Facebook content link URL.' });
  }

  // 1. Time Gate Validation: Check if it is the user's assigned hour
  const activeSystemSlotId = getCurrentSystemSlotId();
  if (assigned_slot_id !== activeSystemSlotId) {
    return res.status(403).json({ 
      error: 'Access Denied.',
      message: `Your assigned slot is ${assigned_slot_id}. The current active slot is ${activeSystemSlotId}.`
    });
  }

  try {
    // 2. User verification check: Verify their active paid Paystack status
    const subscriptionCheck = await db.query(
      "SELECT status FROM subscriptions WHERE user_id = $1 AND status = 'active' AND expires_at > NOW()",
      [user_id]
    );
    
    if (subscriptionCheck.rows.length === 0) {
       return res.status(402).json({ error: 'Payment Required. An active Paystack membership is required to post boost links.' });
    }

    // 3. Calculate the dynamic community numbers on the fly
    const userCountQuery = await db.query("SELECT COUNT(*) FROM users WHERE account_status = 'active'");
    const totalActiveUsers = parseInt(userCountQuery.rows[0].count);

    // 4. PRODUCTION FIX: Calculate exact hourly posting capacity dynamically
    // Divides total users by 24 hours cleanly and rounds up to guarantee allocation slot access.
    const maxAllowedPostsInSlot = Math.max(1, Math.ceil(totalActiveUsers / 24));

    // 5. Count how many links have already been successfully posted in this current slot
    const activePostsQuery = await db.query(
      "SELECT COUNT(*) FROM boost_links WHERE slot_id = $1 AND is_expired = FALSE",
      [activeSystemSlotId]
    );
    const currentActivePosts = parseInt(activePostsQuery.rows[0].count);

    // 6. Enforcement: If the active posts have hit the slot limit, lock the gate
    if (currentActivePosts >= maxAllowedPostsInSlot) {
      return res.status(429).json({
        error: 'Slot Full.',
        message: `This slot has reached its maximum capacity of ${maxAllowedPostsInSlot} posts for this hour cycle. Please try again in the next rotation.`
      });
    }

    // 7. Secure Insert: Add the link to the database
    const newLink = await db.query(
      `INSERT INTO boost_links (creator_id, link_url, slot_id) 
       VALUES ($1, $2, $3) 
       RETURNING link_id, creator_id, link_url, slot_id, created_at`,
      [user_id, link_url, activeSystemSlotId]
    );

    res.status(201).json({
      message: 'Your boost link has been successfully logged into the active cooperative queue!',
      boost: newLink.rows[0]
    });

  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error during link submission sequence.' });
  }
});

// Define your expiration percentage threshold here (e.g., 0.95 means a link needs 95% of active users to click it to expire)
const EXPIRATION_THRESHOLD_PERCENTAGE = 0.95;

// ==========================================
// TASK 4.1: SELF-EXCLUDING FEED GENERATION
// ==========================================
// @route   GET /api/links/feed
// @desc    Get active tasks: hides own link AND links already completed by this user
// @access  Private
router.get('/feed', authMiddleware, async (req, res) => {
  const { user_id } = req.user;

  try {
    const feedQuery = await db.query(
      `SELECT bl.link_id, bl.link_url, bl.slot_id, bl.created_at 
       FROM boost_links bl
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
    res.status(500).json({ error: 'Server error while generating the task feed.' });
  }
});

// ========================================================
// TASK 4.2 & 4.3: ATOMIC ENGAGEMENT PROCESSING ENGINE
// ========================================================
// @route   POST /api/links/engage
// @desc    Process a task click, prevent double-logging, and dynamically check expiration percentage
// @access  Private
router.post('/engage', authMiddleware, async (req, res) => {
  const { link_id } = req.body;
  const { user_id } = req.user;

  if (!link_id) {
    return res.status(400).json({ error: 'Please provide a valid link_id to process.' });
  }

  try {
    const duplicateCheck = await db.query(
      'SELECT 1 FROM completed_engagements WHERE user_id = $1 AND link_id = $2',
      [user_id, link_id]
    );

    if (duplicateCheck.rows.length > 0) {
      return res.status(400).json({ error: 'Task already completed. You cannot log engagement on the same link twice.' });
    }

    await db.query('BEGIN');

    await db.query(
      'INSERT INTO completed_engagements (user_id, link_id) VALUES ($1, $2)',
      [user_id, link_id]
    );

    const userCountQuery = await db.query("SELECT COUNT(*) FROM users WHERE account_status = 'active'");
    const totalActiveUsers = parseInt(userCountQuery.rows[0].count);

    const dynamicTargetClicks = Math.max(1, Math.round(totalActiveUsers * EXPIRATION_THRESHOLD_PERCENTAGE));

    const updateResult = await db.query(
      `UPDATE boost_links
       SET clicks_received = clicks_received + 1,
           is_expired = CASE WHEN clicks_received + 1 >= $1 THEN TRUE ELSE FALSE END
       WHERE link_id = $2
       RETURNING clicks_received, is_expired`,
      [dynamicTargetClicks, link_id]
    );

    await db.query('COMMIT');

    res.status(200).json({
      message: 'Engagement registered successfully!',
      metrics: {
        clicks_received: updateResult.rows[0].clicks_received,
        is_expired: updateResult.rows[0].is_expired,
        current_system_target: dynamicTargetClicks
      }
    });

  } catch (err) {
    await db.query('ROLLBACK');
    console.error(err.message);
    res.status(500).json({ error: 'Server error during engagement logging sequence.' });
  }
});

module.exports = router;
