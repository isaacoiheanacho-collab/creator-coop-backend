const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../db');
const authMiddleware = require('../authMiddleware'); // needed for history route
require('dotenv').config();

// GET /api/payments/history – returns payment records for the logged-in user
router.get('/history', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT payment_id AS id, reference, amount, paid_at AS date, status
       FROM payments
       WHERE user_id = $1
       ORDER BY paid_at DESC`,
      [req.user.user_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch payment history' });
  }
});

// POST /api/payments/webhook – Paystack webhook handler
router.post('/webhook', express.json(), async (req, res) => {
  try {
    // Security: verify Paystack signature
    const hash = crypto
      .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
      .update(JSON.stringify(req.body))
      .digest('hex');

    if (hash !== req.headers['x-paystack-signature']) {
      return res.status(401).json({ error: 'Unauthorized request. Security signature mismatch.' });
    }

    const event = req.body;

    if (event.event === 'charge.success') {
      const { customer, reference, amount } = event.data;
      const email = customer.email;

      // Enforce correct amount (₦5000 = 500000 kobo)
      if (amount !== 500000) {
        console.warn(`⚠️ FRAUD WARNING: Payment rejected. Email ${email} attempted to pay ${amount} Kobo instead of 500000.`);
        return res.status(400).json({ error: 'Fraud detected. Incorrect transaction value.' });
      }

      const userQuery = await db.query('SELECT user_id FROM users WHERE email = $1', [email]);
      if (userQuery.rows.length === 0) {
        console.warn(`⚠️ Payment from unknown email: ${email}`);
        return res.sendStatus(200); // still acknowledge to Paystack
      }

      const userId = userQuery.rows[0].user_id;
      const now = new Date();
      const expiresAt = new Date(now.setFullYear(now.getFullYear() + 1));

      // Upsert subscription (activate or extend)
      await db.query(
        `INSERT INTO subscriptions (user_id, stripe_customer_id, status, expires_at)
         VALUES ($1, $2, 'active', $3)
         ON CONFLICT (user_id) 
         DO UPDATE SET status = 'active', expires_at = $3, updated_at = CURRENT_TIMESTAMP`,
        [userId, reference, expiresAt]
      );

      // Record the payment in the payments table
      await db.query(
        `INSERT INTO payments (user_id, reference, amount, status, paid_at)
         VALUES ($1, $2, $3, 'success', NOW())`,
        [userId, reference, amount]
      );

      console.log(`✅ Membership activated for user ${userId} until ${expiresAt}`);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ PAYSTACK WEBHOOK ERROR:', err.message);
    res.status(500).json({ error: 'Internal processing error.' });
  }
});

module.exports = router;