const jwt = require('jsonwebtoken');
const db = require('./db');
require('dotenv').config();

module.exports = async function (req, res, next) {
  // 1. Get the authorization token from the request header
  const authHeader = req.header('Authorization');

  // Check if token does not exist
  if (!authHeader) {
    return res.status(401).json({ error: 'Access denied. No authorization token provided.' });
  }

  try {
    // 2. Extract the clean token string (Splitting 'Bearer <token>')
    const token = authHeader.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Access denied. Invalid token formatting.' });
    }

    // 3. Decode and verify the token using your system's deep secret key
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // 4. NEW: Check if this session is active in the database
    const sessionCheck = await db.query(
      'SELECT is_active FROM user_sessions WHERE token = $1 AND user_id = $2',
      [token, decoded.user_id]
    );

    if (sessionCheck.rows.length === 0) {
      return res.status(401).json({ 
        error: 'Session not found. Please log in again.' 
      });
    }

    if (sessionCheck.rows[0].is_active === false) {
      return res.status(401).json({ 
        error: 'Session expired or logged out elsewhere. Please log in again.' 
      });
    }

    // 5. Update last_active timestamp
    await db.query(
      'UPDATE user_sessions SET last_active = NOW() WHERE token = $1',
      [token]
    );

    // 6. Attach the user's decrypted session data to the request object
    req.user = decoded;
    req.token = token;
    
    // 7. Move securely to the next step of the pipeline
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