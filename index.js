const express = require('express');
const cors = require('cors');
const db = require('./db');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// ✅ ADD YOUR NETLIFY URL HERE (and any other production domains)
const allowedOrigins = process.env.NODE_ENV === 'production'
  ? [
      'https://creator-coop-2026.netlify.app'   // 👈 YOUR FRONTEND ON NETLIFY
      // Add more if needed: 'https://www.yourdomain.com'
    ]
  : [
      'http://localhost:5500',
      'http://localhost:3000',
      'http://127.0.0.1:5500',
      'http://127.0.0.1:3000'
    ];

// Enhanced CORS middleware (handles preflight OPTIONS correctly)
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, curl)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.warn(`CORS blocked origin: ${origin}`);
      callback(new Error(`CORS policy: ${origin} not allowed`));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Routes
const authRoutes = require('./routes/auth');
const linkRoutes = require('./routes/links');
const paymentRoutes = require('./routes/payments');
const profileRoutes = require('./routes/profile');
const boostRoutes = require('./routes/boosts');   // 👈 NEW: boosts endpoint

app.use('/api/auth', authRoutes);
app.use('/api/links', linkRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/boosts', boostRoutes);              // 👈 NEW: register boosts route

// Health check
app.get('/api/health', async (req, res) => {
  try {
    const result = await db.query('SELECT NOW()');
    res.status(200).json({
      status: 'Online',
      message: 'Backend is connected to Neon successfully!',
      timestamp: result.rows[0].now
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'Offline', error: 'Database connection failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running in ${process.env.NODE_ENV || 'development'} mode on port ${PORT}`);
});