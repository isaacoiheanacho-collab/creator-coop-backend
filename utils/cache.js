// utils/cache.js
const Redis = require('ioredis');
require('dotenv').config();

// Redis connection configuration
let redis = null;
let redisConnected = false;

// Memory cache fallback (used when Redis is unavailable)
const memoryCache = new Map();

try {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  // Check if we have Upstash configuration
  if (url && token) {
    // Extract host from URL (remove https://)
    const host = url.replace('https://', '').replace('http://', '');
    
    console.log(`🔗 Connecting to Upstash Redis: ${host}`);
    
    redis = new Redis({
      host: host,
      port: 6379,
      password: token,
      tls: {}, // Required for Upstash
      retryStrategy: (times) => {
        if (times > 5) {
          console.error('❌ Redis connection failed after 5 retries');
          return null; // Stop retrying
        }
        return Math.min(times * 100, 3000);
      },
      maxRetriesPerRequest: 2,
      connectTimeout: 10000,
      lazyConnect: true, // Don't connect immediately
    });

    // Attempt connection
    redis.connect().catch((err) => {
      console.warn(`⚠️ Redis connection failed: ${err.message}`);
      console.warn('   Using memory cache fallback');
      redis = null;
    });

  } else if (process.env.UPSTASH_REDIS_URL) {
    // Alternative: Use the TCP URL format
    console.log('🔗 Connecting to Upstash Redis via TCP URL');
    
    redis = new Redis(process.env.UPSTASH_REDIS_URL, {
      tls: {}, // Required for Upstash
      retryStrategy: (times) => {
        if (times > 5) {
          console.error('❌ Redis connection failed after 5 retries');
          return null;
        }
        return Math.min(times * 100, 3000);
      },
      maxRetriesPerRequest: 2,
      connectTimeout: 10000,
      lazyConnect: true,
    });

    redis.connect().catch((err) => {
      console.warn(`⚠️ Redis connection failed: ${err.message}`);
      console.warn('   Using memory cache fallback');
      redis = null;
    });

  } else {
    // No Redis configuration - use memory cache only
    console.log('ℹ️ No Redis configuration found, using memory cache only');
    redis = null;
  }

} catch (err) {
  console.warn(`⚠️ Redis setup error: ${err.message}`);
  console.warn('   Using memory cache fallback');
  redis = null;
}

// Event handlers
if (redis) {
  redis.on('connect', () => {
    redisConnected = true;
    console.log('✅ Redis cache connected');
  });

  redis.on('ready', () => {
    console.log('✅ Redis cache ready');
  });

  redis.on('error', (err) => {
    if (err.message && err.message.includes('ECONNREFUSED')) {
      // Connection refused - Redis is down
      redisConnected = false;
      console.warn('⚠️ Redis connection refused - using memory cache');
    } else if (err.message && !err.message.includes('ECONNRESET')) {
      console.error('❌ Redis error:', err.message);
    }
  });

  redis.on('close', () => {
    redisConnected = false;
    console.log('🔴 Redis connection closed');
  });
}

// Cache TTLs (in seconds)
const CACHE_TTL = {
  USER_PROFILE: 300,     // 5 minutes
  BOOST_FEED: 60,        // 1 minute
  USER_BOOSTS: 120,      // 2 minutes
  NOTIFICATIONS: 30,     // 30 seconds
  PLATFORM_STATS: 3600,  // 1 hour
  SUBSCRIPTION: 300,     // 5 minutes
};

// Generic cache getter with memory fallback
async function getCached(key) {
  // Try Redis first
  if (redis && redisConnected) {
    try {
      const data = await redis.get(key);
      if (data !== null) {
        return JSON.parse(data);
      }
    } catch (err) {
      // Redis error - fallback to memory
      if (!err.message.includes('ECONNREFUSED')) {
        console.error('Cache get error:', err.message);
      }
    }
  }

  // Memory cache fallback
  const item = memoryCache.get(key);
  if (item && item.expiry > Date.now()) {
    return item.data;
  }
  memoryCache.delete(key);
  return null;
}

// Generic cache setter with memory fallback
async function setCached(key, data, ttl = 300) {
  // Try Redis first
  if (redis && redisConnected) {
    try {
      await redis.set(key, JSON.stringify(data), 'EX', ttl);
      return true;
    } catch (err) {
      // Redis error - fallback to memory
      if (!err.message.includes('ECONNREFUSED')) {
        console.error('Cache set error:', err.message);
      }
    }
  }

  // Memory cache fallback
  memoryCache.set(key, {
    data: data,
    expiry: Date.now() + (ttl * 1000)
  });
  
  // Clean up old memory cache entries if too many
  if (memoryCache.size > 1000) {
    const now = Date.now();
    for (const [key, value] of memoryCache) {
      if (value.expiry < now) {
        memoryCache.delete(key);
      }
    }
  }
  
  return true;
}

// Cache invalidation by pattern
async function invalidateCache(pattern) {
  // Try Redis first
  if (redis && redisConnected) {
    try {
      const keys = await redis.keys(pattern);
      if (keys.length > 0) {
        await redis.del(...keys);
        console.log(`🗑️ Invalidated ${keys.length} cache keys matching: ${pattern}`);
      }
      return;
    } catch (err) {
      // Redis error - fallback to memory
    }
  }

  // Memory cache fallback
  const patternRegex = new RegExp(pattern.replace('*', '.*'));
  let count = 0;
  for (const key of memoryCache.keys()) {
    if (patternRegex.test(key)) {
      memoryCache.delete(key);
      count++;
    }
  }
  if (count > 0) {
    console.log(`🗑️ Invalidated ${count} memory cache keys matching: ${pattern}`);
  }
}

// Cache invalidation by user ID
async function invalidateUserCache(userId) {
  await invalidateCache(`user:${userId}:*`);
  await invalidateCache(`feed:${userId}`);
  await invalidateCache(`boosts:${userId}:*`);
}

// Health check for cache
async function cacheHealth() {
  if (redis && redisConnected) {
    try {
      await redis.ping();
      return { status: 'connected', type: 'redis' };
    } catch (err) {
      return { status: 'error', error: err.message, type: 'redis' };
    }
  }
  return { 
    status: 'memory', 
    message: 'Using memory cache fallback', 
    type: 'memory',
    entries: memoryCache.size 
  };
}

// Close Redis connection
async function closeRedis() {
  if (redis) {
    try {
      await redis.quit();
      console.log('🔴 Redis connection closed');
    } catch (err) {
      console.error('Error closing Redis:', err.message);
    }
  }
  memoryCache.clear();
  console.log('🧹 Memory cache cleared');
}

module.exports = {
  redis,
  getCached,
  setCached,
  invalidateCache,
  invalidateUserCache,
  cacheHealth,
  closeRedis,
  CACHE_TTL,
};