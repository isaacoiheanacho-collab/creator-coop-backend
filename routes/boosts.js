const express = require('express');
const router = express.Router();
const db = require('../db');
const authMiddleware = require('../authMiddleware');

// GET /api/boosts?limit=100
router.get('/', authMiddleware, async (req, res) => {
  const { user_id } = req.user;
  const limit = parseInt(req.query.limit) || 100;
  try {
    const result = await db.query(
      `SELECT link_id, link_url AS original_url, created_at AS submitted_at, 
              clicks_received AS engagement_count, is_expired AS status
       FROM boost_links
       WHERE creator_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [user_id, limit]
    );
    // Convert status: is_expired false -> 'active', true -> 'completed'
    const boosts = result.rows.map(row => ({
      ...row,
      status: row.status ? 'completed' : 'active'
    }));
    res.json({ boosts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch boosts' });
  }
});

module.exports = router;