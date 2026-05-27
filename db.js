const { Pool } = require('pg');
require('dotenv').config();

// Check if we are running live on Render or locally
const isProduction = process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render database hosting requires SSL encryption. 
  // This block turns it on automatically only when deployed live.
  ssl: isProduction ? { rejectUnauthorized: false } : false
});

module.exports = {
  query: (text, params) => pool.query(text, params),
};
