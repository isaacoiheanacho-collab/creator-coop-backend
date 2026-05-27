const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../db');
require('dotenv').config();

// @route   POST /api/payments/webhook
// @desc    Secure Paystack webhook receiver to verify payments and activate memberships
// @access  Public (Called securely by Paystack's servers)
router.post('/webhook', express.json(), async (req, res) => {
  try {
    // 1. SECURITY HANDSHAKE: Verify that this request actually came from Paystack
    const hash = crypto
      .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
      .update(JSON.stringify(req.body))
      .digest('hex');

    if (hash !== req.headers['x-paystack-signature']) {
      return res.status(401).json({ error: 'Unauthorized request. Security signature mismatch.' });
    }

    const event = req.body;

    // 2. LISTEN FOR SUCCESSFUL CHARGES
    if (event.event === 'charge.success') {
      const { customer, reference, amount } = event.data;
      const email = customer.email;

      // 3. THE BACKEND PRICE AUDIT CHECK
      // Paystack measures currency in Kobo. 
      // ₦5,000 multiplied by 100 equals exactly 500,000 Kobo.
      if (amount !== 500000) {
         console.warn(`⚠️ FRAUD WARNING: Payment rejected. Email ${email} attempted to pay ${amount} Kobo instead of 500000.`);
         return res.status(400).json({ error: 'Fraud detected. Incorrect transaction value.' });
      }

      // 4. FIND USER & ACTIVATE MEMBERSHIP
      const userQuery = await db.query('SELECT user_id FROM users WHERE email = $1', [email]);
      
      if (userQuery.rows.length > 0) {
        const userId = userQuery.rows[0].user_id;

        // Calculate lifespan: 1 year (365 days) from right now
        const now = new Date();
        const expiresAt = new Date(now.setFullYear(now.getFullYear() + 1));

        // ATOMIC UPSERT: Insert active status, or extend it if they are renewing
        await db.query(
          `INSERT INTO subscriptions (user_id, stripe_customer_id, status, expires_at)
           VALUES ($1, $2, 'active', $3)
           ON CONFLICT (user_id) 
           DO UPDATE SET status = 'active', expires_at = $3, updated_at = CURRENT_TIMESTAMP`,
          [userId, reference, expiresAt] // Saving Paystack transaction reference as the identifier
        );

        console.log(`💰 SYSTEM ACTIVATION: 1-Year Membership successfully unlocked for User ID ${userId}.`);
      }
    }

    // Always respond with a 200 OK to Paystack so they know the server received it successfully
    res.sendStatus(200);

  } catch (err) {
    console.error('❌ PAYSTACK WEBHOOK ERROR:', err.message);
    res.status(500).json({ error: 'Internal processing error.' });
  }
});

module.exports = router;
