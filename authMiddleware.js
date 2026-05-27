const jwt = require('jsonwebtoken');
require('dotenv').config();

module.exports = function (req, res, next) {
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

    // 4. Attach the user's decrypted session data (user_id and assigned_slot_id) to the request object
    req.user = decoded;
    
    // 5. Move securely to the next step of the pipeline (e.g., fetching a feed or posting a link)
    next();
  } catch (err) {
    res.status(401).json({ error: 'Access denied. Token is expired or invalid.' });
  }
};
