const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const webPush = require('web-push');
const db = require('./db');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 5000;

// ============================================================
// WEB PUSH NOTIFICATIONS SETUP
// ============================================================
let pushSubscriptions = [];

webPush.setVapidDetails(
  'mailto:support@creatorcooptechnologies.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ============================================================
// SOCKET.IO SETUP
// ============================================================
const io = new Server(server, {
  cors: {
    origin: process.env.NODE_ENV === 'production'
      ? ['https://creatorcooptechnologies.com', 'https://www.creatorcooptechnologies.com']
      : ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:5500'],
    credentials: true,
    methods: ['GET', 'POST']
  }
});

const activeUsers = new Map();

io.on('connection', (socket) => {
  console.log('🟢 New client connected:', socket.id);

  socket.on('register-user', (userId) => {
    if (userId) {
      activeUsers.set(userId, socket.id);
      console.log(`👤 User ${userId} registered (${activeUsers.size} online)`);
    }
  });

  socket.on('disconnect', () => {
    let disconnectedUser = null;
    for (const [userId, socketId] of activeUsers.entries()) {
      if (socketId === socket.id) {
        disconnectedUser = userId;
        activeUsers.delete(userId);
        break;
      }
    }
    if (disconnectedUser) {
      console.log(`🔴 User ${disconnectedUser} disconnected (${activeUsers.size} online)`);
    }
  });
});

app.set('io', io);
app.set('activeUsers', activeUsers);

// ============================================================
// CORS
// ============================================================
const allowedOrigins = process.env.NODE_ENV === 'production'
  ? [
      'https://creatorcooptechnologies.com',
      'https://www.creatorcooptechnologies.com',
      'https://creator-coop.vercel.app',
      'https://creator-coop.netlify.app'
    ]
  : [
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:5500',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:3001',
      'http://127.0.0.1:5500'
    ];

app.use(cors({
  origin: function (origin, callback) {
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

// ============================================================
// PUSH NOTIFICATION ROUTES
// ============================================================
app.get('/api/notifications/vapid-public-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

app.post('/api/notifications/subscribe', (req, res) => {
  const subscription = req.body;
  pushSubscriptions.push(subscription);
  console.log(`📱 Push subscription added (${pushSubscriptions.length} total)`);
  res.json({ message: 'Subscribed successfully' });
});

// Function to send push notifications (accessible from routes)
async function sendPushNotifications(message) {
  const payload = JSON.stringify({
    body: message,
    url: 'https://creatorcooptechnologies.com/queue.html'
  });

  const results = [];
  for (const subscription of pushSubscriptions) {
    try {
      await webPush.sendNotification(subscription, payload);
      results.push({ success: true });
    } catch (err) {
      console.error('Push notification failed:', err.message);
      results.push({ success: false, error: err.message });
    }
  }
  return results;
}

// Make pushSubscriptions and sendPushNotifications available to routes
app.set('pushSubscriptions', pushSubscriptions);
app.set('sendPushNotifications', sendPushNotifications);

// ============================================================
// ROUTES
// ============================================================
const authRoutes = require('./routes/auth');
const linkRoutes = require('./routes/links');
const paymentRoutes = require('./routes/payments');
const profileRoutes = require('./routes/profile');
const boostRoutes = require('./routes/boosts');
const adminRoutes = require('./routes/admin');

app.use('/api/auth', authRoutes);
app.use('/api/links', linkRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/boosts', boostRoutes);
app.use('/api/admin', adminRoutes);

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

// ============================================================
// START SERVER
// ============================================================
server.listen(PORT, () => {
  console.log(`Server running in ${process.env.NODE_ENV || 'development'} mode on port ${PORT}`);
  console.log(`📱 Push notifications enabled with VAPID keys`);
});