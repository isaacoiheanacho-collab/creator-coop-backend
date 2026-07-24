const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const webPush = require('web-push');
const db = require('./db');
const { closeRedis, cacheHealth } = require('./utils/cache');
const { dailyCleanup, getStorageStats, getDatabaseSize } = require('./utils/cleanup');
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
// AUTH MIDDLEWARE (for cleanup endpoints)
// ============================================================
const authMiddleware = require('./authMiddleware');

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
// CACHE HEALTH CHECK ENDPOINT
// ============================================================
app.get('/api/cache/health', async (req, res) => {
  try {
    const health = await cacheHealth();
    res.status(200).json({
      status: 'OK',
      cache: health
    });
  } catch (err) {
    res.status(500).json({
      status: 'ERROR',
      error: err.message
    });
  }
});

// ============================================================
// CLEANUP API ENDPOINTS
// ============================================================

// GET /api/cleanup/stats - View storage stats (public)
app.get('/api/cleanup/stats', async (req, res) => {
  try {
    const size = await getDatabaseSize();
    const stats = await getStorageStats();
    
    if (!size || !stats) {
      return res.status(500).json({ error: 'Failed to fetch storage stats' });
    }
    
    res.json({
      size,
      stats,
      limits: {
        storage_limit_mb: 500,
        storage_percentage_used: size ? ((parseFloat(size.size_mb) / 500) * 100).toFixed(1) : 0,
        remaining_mb: size ? (500 - parseFloat(size.size_mb)).toFixed(2) : 0
      },
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cleanup/run - Run cleanup (admin only)
app.post('/api/cleanup/run', authMiddleware, async (req, res) => {
  try {
    // Check if user is admin
    const adminCheck = await db.query(
      'SELECT is_admin FROM users WHERE user_id = $1',
      [req.user.user_id]
    );
    
    if (!adminCheck.rows[0]?.is_admin) {
      return res.status(403).json({ error: 'Admin access required.' });
    }
    
    // Get size before cleanup
    const beforeSize = await getDatabaseSize();
    
    // Run cleanup
    const result = await dailyCleanup();
    
    // Get size after cleanup
    const afterSize = await getDatabaseSize();
    
    // Calculate savings
    let savings = null;
    if (beforeSize && afterSize) {
      savings = {
        mb: (parseFloat(beforeSize.size_mb) - parseFloat(afterSize.size_mb)).toFixed(2),
        percentage: ((1 - parseFloat(afterSize.size_mb) / parseFloat(beforeSize.size_mb)) * 100).toFixed(1)
      };
    }
    
    res.json({
      ...result,
      before_size: beforeSize,
      after_size: afterSize,
      savings: savings,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Cleanup run error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cleanup/status - Get cleanup status (admin only)
app.get('/api/cleanup/status', authMiddleware, async (req, res) => {
  try {
    // Check if user is admin
    const adminCheck = await db.query(
      'SELECT is_admin FROM users WHERE user_id = $1',
      [req.user.user_id]
    );
    
    if (!adminCheck.rows[0]?.is_admin) {
      return res.status(403).json({ error: 'Admin access required.' });
    }
    
    const size = await getDatabaseSize();
    const stats = await getStorageStats();
    
    res.json({
      status: 'healthy',
      database: size,
      stats: stats,
      limits: {
        storage_limit_mb: 500,
        storage_percentage_used: size ? ((parseFloat(size.size_mb) / 500) * 100).toFixed(1) : 0,
        remaining_mb: size ? (500 - parseFloat(size.size_mb)).toFixed(2) : 0
      },
      recommendation: size && parseFloat(size.size_mb) > 400 
        ? '⚠️ Storage is above 400MB. Consider running cleanup soon.'
        : '✅ Storage is within healthy limits.',
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ROUTES
// ============================================================
const authRoutes = require('./routes/auth');
const linkRoutes = require('./routes/links');
const paymentRoutes = require('./routes/payments');
const profileRoutes = require('./routes/profile');
const boostRoutes = require('./routes/boosts');
const adminRoutes = require('./routes/admin');
const digestRoutes = require('./routes/digest');

app.use('/api/auth', authRoutes);
app.use('/api/links', linkRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/boosts', boostRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/digest', digestRoutes);

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/api/health', async (req, res) => {
  try {
    const result = await db.query('SELECT NOW()');
    const cacheHealthResult = await cacheHealth();
    res.status(200).json({
      status: 'Online',
      message: 'Backend is connected to Neon successfully!',
      timestamp: result.rows[0].now,
      cache: cacheHealthResult
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ 
      status: 'Offline', 
      error: 'Database connection failed',
      cache: await cacheHealth()
    });
  }
});

// ============================================================
// WAKE ENDPOINT - Pre-wake Render to prevent 503 errors
// ============================================================
app.get('/api/wake', (req, res) => {
  const timestamp = new Date().toISOString();
  console.log(`⏰ [Wake] Render woken up at ${timestamp}`);
  res.json({ 
    status: 'awake', 
    timestamp: timestamp,
    message: 'Render is awake and ready for digest jobs'
  });
});

// ============================================================
// START SERVER
// ============================================================
const serverInstance = server.listen(PORT, () => {
  console.log(`🚀 Server running in ${process.env.NODE_ENV || 'development'} mode on port ${PORT}`);
  console.log(`📱 Push notifications enabled with VAPID keys`);
  
  // Check cache connection on startup
  cacheHealth().then(health => {
    if (health.status === 'connected') {
      console.log('✅ Redis cache connected successfully');
    } else {
      console.warn(`⚠️ Redis cache: ${health.status} - ${health.error || 'Not available'}`);
      console.warn('   Cache will be disabled - this is fine for development');
    }
  });
});

// ============================================================
// AUTOMATED CLEANUP SCHEDULER
// ============================================================

// Run cleanup every 24 hours (at 2 AM server time)
// Since Render doesn't support cron natively, we use setInterval
const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

// Schedule the first cleanup to run at 2 AM tomorrow
function getNextCleanupTime() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(2, 0, 0, 0); // Set to 2:00 AM
  if (next <= now) {
    next.setDate(next.getDate() + 1); // If 2 AM has passed, go to tomorrow
  }
  return next;
}

// Initial delay until 2 AM
const nextCleanup = getNextCleanupTime();
const initialDelay = nextCleanup.getTime() - Date.now();

console.log(`🕐 Next scheduled cleanup at: ${nextCleanup.toLocaleString()}`);
console.log(`⏳ Waiting ${Math.round(initialDelay / 60000)} minutes...`);

// Schedule the cleanup
setTimeout(() => {
  // Run immediately at 2 AM
  console.log('🔄 Running scheduled daily cleanup...');
  dailyCleanup().then(result => {
    console.log('✅ Scheduled cleanup completed:', result);
  }).catch(err => {
    console.error('❌ Scheduled cleanup failed:', err);
  });
  
  // Then run every 24 hours thereafter
  setInterval(async () => {
    console.log('🔄 Running scheduled daily cleanup...');
    try {
      const result = await dailyCleanup();
      console.log('✅ Scheduled cleanup completed:', result);
    } catch (err) {
      console.error('❌ Scheduled cleanup failed:', err);
    }
  }, CLEANUP_INTERVAL);
  
}, initialDelay);

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================
async function gracefulShutdown(signal) {
  console.log(`\n🛑 Received ${signal}. Shutting down gracefully...`);
  
  // Close Redis connection
  console.log('📊 Closing Redis connection...');
  await closeRedis();
  
  // Close server
  console.log('📡 Closing HTTP server...');
  serverInstance.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
  
  // Force shutdown after 10 seconds if not closed
  setTimeout(() => {
    console.error('⚠️ Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

// Handle shutdown signals
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught exception:', err);
  gracefulShutdown('uncaughtException');
});

// Handle unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled rejection:', reason);
});

// ============================================================
// EXPORT FOR TESTING
// ============================================================
module.exports = { app, serverInstance };