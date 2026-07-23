const { Pool } = require('pg');
require('dotenv').config();

const isProduction = process.env.NODE_ENV === 'production';

// ✅ Use the URL as-is - it already contains the pooler
const connectionString = process.env.DATABASE_URL;

// ✅ Check if pooler is already in the URL (for logging only)
if (isProduction && connectionString && connectionString.includes('-pooler.neon.tech')) {
  console.log('🔗 Using Neon connection pooler (already in URL)');
}

// Configure the connection pool with optimized timeout settings for Neon free tier
const pool = new Pool({
  connectionString: connectionString,
  max: 20,
  idleTimeoutMillis: 10000,        // ✅ Close idle connections after 10s (allows Neon to sleep)
  connectionTimeoutMillis: 5000,   // ✅ Fail fast if can't connect
  ssl: isProduction ? { rejectUnauthorized: false } : false,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

// Log connection pool events
pool.on('connect', () => {
  console.log('📊 Database pool: New client connected');
});

pool.on('error', (err) => {
  console.error('❌ Database pool error:', err.message);
});

// Graceful shutdown
const closePool = async () => {
  try {
    await pool.end();
    console.log('📊 Database pool closed');
  } catch (err) {
    console.error('❌ Error closing database pool:', err.message);
  }
};

process.on('SIGINT', closePool);
process.on('SIGTERM', closePool);

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool: pool,
  closePool: closePool
};