const jwt = require('jsonwebtoken');
const db = require('./db');
require('dotenv').config();

module.exports = async function (req, res, next) {
  const authHeader = req.header('Authorization');

  if (!authHeader) {
    return res.status(401).json({ error: 'Access denied. No authorization token provided.' });
  }

  try {
    const token = authHeader.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Access denied. Invalid token formatting.' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Check if this session is active in the database
    const sessionCheck = await db.query(
      'SELECT is_active FROM user_sessions WHERE token = $1 AND user_id = $2',
      [token, decoded.user_id]
    );

    if (sessionCheck.rows.length === 0) {
      return res.status(401).json({ 
        error: 'Session not found. Please log in again.',
        code: 'SESSION_NOT_FOUND'
      });
    }

    if (sessionCheck.rows[0].is_active === false) {
      return res.status(401).json({ 
        error: 'Session expired. You have been logged out from another device.',
        code: 'SESSION_EXPIRED'
      });
    }

    // Update last_active timestamp
    await db.query(
      'UPDATE user_sessions SET last_active = NOW() WHERE token = $1',
      [token]
    );

    req.user = decoded;
    req.token = token;
    next();
    
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Access denied. Token has expired.' });
    }
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Access denied. Invalid token.' });
    }
    console.error('Auth middleware error:', err);
    res.status(500).json({ error: 'Server error during authentication.' });
  }
};
