const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');      // 👈 needed for Paystack API call
const db = require('../db');
const authMiddleware = require('../authMiddleware');
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

// POST /api/payments/initiate – create Paystack transaction and return redirect URL
router.post('/initiate', authMiddleware, async (req, res) => {
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
        amount: 500000, // ₦5000,00 in kobo
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
      // Store the reference temporarily (optional – you could save in a pending_payments table)
      // For now, the webhook will handle the success
      res.json({ authorization_url: response.data.data.authorization_url });
    } else {
      throw new Error(response.data.message || 'Paystack initialization failed');
    }
  } catch (err) {
    console.error('❌ Payment initiation error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Payment initiation failed. Please try again later.' });
  }
});

// POST /api/payments/webhook – Paystack webhook handler (unchanged)
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

      if (amount !== 500000) {
        console.warn(`⚠️ FRAUD WARNING: Payment rejected. Email ${email} attempted to pay ${amount} Kobo instead of 500000.`);
        return res.status(400).json({ error: 'Fraud detected. Incorrect transaction value.' });
      }

      const userQuery = await db.query('SELECT user_id FROM users WHERE email = $1', [email]);
      if (userQuery.rows.length === 0) {
        console.warn(`⚠️ Payment from unknown email: ${email}`);
        return res.sendStatus(200);
      }

      const userId = userQuery.rows[0].user_id;
      const now = new Date();
      const expiresAt = new Date(now.setFullYear(now.getFullYear() + 1));

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

      console.log(`✅ Membership activated for user ${userId} until ${expiresAt}`);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ PAYSTACK WEBHOOK ERROR:', err.message);
    res.status(500).json({ error: 'Internal processing error.' });
  }
});

module.exports = router;