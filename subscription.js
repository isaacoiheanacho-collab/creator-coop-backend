// GET /api/auth/me (returns user + subscription status)
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const userRes = await db.query('SELECT user_id, username, email, assigned_slot_id FROM users WHERE user_id = $1', [req.user.user_id]);
    const subRes = await db.query('SELECT status, expires_at FROM subscriptions WHERE user_id = $1 AND status = $2', [req.user.user_id, 'active']);
    const isActive = subRes.rows.length > 0 && new Date(subRes.rows[0].expires_at) > new Date();
    res.json({ user: userRes.rows[0], subscription_active: isActive });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});