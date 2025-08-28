const { Pool } = require('pg');

// Create a connection pool
const pool = new Pool({
    user: 'postgres',         // Replace with your PostgreSQL username
    host: 'localhost',             // Database host
    database: 'ecommerce_api',     // Replace with your database name
    password: 'postgres',     // Replace with your PostgreSQL password
    port: 5432,                    // Default PostgreSQL port
});

module.exports = pool;
