const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const db = require('../db');
const authMiddleware = require('../authMiddleware');
require('dotenv').config();

// ============================================================
// MILESTONE CHECK - 5,000 users required for payments
// ============================================================
async function check5kUserMilestone(req, res, next) {
  try {
    const userCountRes = await db.query('SELECT COUNT(*) FROM users');
    const totalUsers = parseInt(userCountRes.rows[0].count, 10);

    // If total users is under 5,000, suspend paid subscriptions
    if (totalUsers < 5000) {
      return res.status(403).json({
        error: 'Creator Co-Op is currently 100% FREE for all early creators! Subscriptions will unlock once we reach 5,000 active creators.',
        current_users: totalUsers,
        required_users: 5000,
        remaining: 5000 - totalUsers
      });
    }

    next();
  } catch (err) {
    console.error('❌ Milestone check error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ============================================================
// GET /api/payments/history – returns payment records for the logged-in user
// ============================================================
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

// ============================================================
// POST /api/payments/initiate – create Paystack transaction (MILESTONE PROTECTED)
// ============================================================
router.post('/initiate', authMiddleware, check5kUserMilestone, async (req, res) => {
  const { user_id } = req.user;

  try {
    // 1. Get user's email from database
    const userRes = await db.query('SELECT email FROM users WHERE user_id = $1', [user_id]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const email = userRes.rows[0].email;

    // 2. Generate unique reference
    const reference = `COOP_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    // 3. Call Paystack initialization API
    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email,
        amount: 20000, // ₦200.00 in kobo (monthly subscription)
        reference,
        callback_url: 'https://creatorcooptechnologies.com/settings.html?payment=success'
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (response.data.status) {
      res.json({ authorization_url: response.data.data.authorization_url });
    } else {
      throw new Error(response.data.message || 'Paystack initialization failed');
    }
  } catch (err) {
    console.error('❌ Payment initiation error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Payment initiation failed. Please try again later.' });
  }
});

// ============================================================
// POST /api/payments/webhook – Paystack webhook handler
// ============================================================
router.post('/webhook', express.json(), async (req, res) => {
  try {
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

      // Validate amount: ₦200.00 = 20,000 kobo
      if (amount !== 20000) {
        console.warn(`⚠️ FRAUD WARNING: Payment rejected. Email ${email} attempted to pay ${amount} Kobo instead of 20000.`);
        return res.status(400).json({ error: 'Fraud detected. Incorrect transaction value.' });
      }

      const userQuery = await db.query('SELECT user_id FROM users WHERE email = $1', [email]);
      if (userQuery.rows.length === 0) {
        console.warn(`⚠️ Payment from unknown email: ${email}`);
        return res.sendStatus(200);
      }

      const userId = userQuery.rows[0].user_id;
      const now = new Date();
      // Set expiry to 1 month from now (monthly subscription)
      const expiresAt = new Date(now.setMonth(now.getMonth() + 1));

      await db.query(
        `INSERT INTO subscriptions (user_id, stripe_customer_id, status, expires_at)
         VALUES ($1, $2, 'active', $3)
         ON CONFLICT (user_id) 
         DO UPDATE SET status = 'active', expires_at = $3, updated_at = CURRENT_TIMESTAMP`,
        [userId, reference, expiresAt]
      );

      await db.query(
        `INSERT INTO payments (user_id, reference, amount, status, paid_at)
         VALUES ($1, $2, $3, 'success', NOW())`,
        [userId, reference, amount]
      );

      console.log(`✅ Monthly membership activated for user ${userId} until ${expiresAt}`);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ PAYSTACK WEBHOOK ERROR:', err.message);
    res.status(500).json({ error: 'Internal processing error.' });
  }
});

module.exports = router;