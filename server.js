
require('dotenv').config();
console.log("🔍 APP_BASE_URL from .env:", process.env.APP_BASE_URL);


if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const express = require('express');
const cors = require('cors');
const pool = require('./db');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const bwipjs = require('bwip-js');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const sendResetEmail = require('./utils/sendEmail');
const crypto = require('crypto');



const app = express();

app.use(cors({
  origin: function (origin, callback) {
    const allowedOrigins = ['https://tajernow.com', 'http://localhost:3000'];
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));


app.options('*', cors());


app.use(express.json());

// Ensure DB schema
async function ensureSchema() {
  const sql = `
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) NOT NULL,
      email VARCHAR(100) NOT NULL UNIQUE,
      password TEXT NOT NULL,
      role VARCHAR(20) DEFAULT 'customer',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      description TEXT,
      price NUMERIC(10,2),
      vendor_id INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS orders (
      id UUID PRIMARY KEY,
      customer_id INTEGER,
      vendor_id INTEGER REFERENCES users(id),
      barcode TEXT,
      guest_name TEXT,
      guest_contact TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY,
      order_id UUID REFERENCES orders(id),
      product_id INTEGER REFERENCES products(id),
      quantity INTEGER
    );
  `;
  await pool.query(sql);
}
ensureSchema();

// Test route
app.get('/test', (req, res) => {
  res.send('✅ Test route is working!');
});

// Get all products
app.get('/api/products', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.id, p.name, p.price, p.description, p.vendor_id, 
             u.username AS vendor_name
      FROM products p
      JOIN users u ON p.vendor_id = u.id
      WHERE u.role = 'vendor'   -- ✅ only allow vendors
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});


// Search products
app.get('/api/search', async (req, res) => {
  const search = (req.query.query || '').trim();
  if (!search) return res.json([]);

  try {
    const result = await pool.query(
      `SELECT p.id, p.name, p.price, p.description,  p.vendor_id, u.username AS vendor_name
       FROM products p
       JOIN users u ON p.vendor_id = u.id
       WHERE p.name ILIKE $1`,
      [`%${search}%`]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ message: 'Search failed' });
  }
});

// Get vendor by name
app.get('/api/vendors/by-name/:vendorName', async (req, res) => {
  const { vendorName } = req.params;
  try {
    const result = await pool.query(
      `SELECT id, username AS name, email FROM users WHERE username = $1 AND role = 'vendor'`,
      [vendorName]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Vendor not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching vendor by name:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get products by vendor
app.get('/api/vendor/:vendorId/products', async (req, res) => {
  const { vendorId } = req.params;
  try {
    const result = await pool.query(
      'SELECT * FROM products WHERE vendor_id = $1',
      [vendorId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching vendor products:', error);
    res.status(500).json({ message: 'Server error' });
  }
});


// Login Route
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    console.log("❌ Missing email or password");
    return res.status(400).json({ message: "Email and password are required." });
  }

  try {
    const result = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
    const user = result.rows[0];

    if (!user) {
      console.log(`❌ Login failed — email not found: ${email}`);
      return res.status(401).json({ message: "Email not found." });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      console.log(`❌ Login failed — incorrect password for ${email}`);
      return res.status(401).json({ message: "Incorrect password." });
    }

    console.log(`✅ Login successful for ${email}`);

    // ✅ Wrap user in `user` key
    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role
      }
    });

  } catch (err) {
    console.error('🔥 Login error:', err.message);
    res.status(500).json({ message: "Server error during login." });
  }
});


// SignUp Route
app.post('/api/signup', async (req, res) => {
  const { username, email, password, role } = req.body;

  try {
    // Check if email already exists
    const emailCheck = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]);
    if (emailCheck.rows.length > 0) {
      return res.status(400).json({ message: 'Email is already registered.' });
    }

    // Hash password and insert user
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query(
      `INSERT INTO users (username, email, password, role) VALUES ($1, $2, $3, $4)`,
      [username, email, hashedPassword, role]
    );

    res.status(201).json({ message: 'User registered successfully!' });

  } catch (err) {
    console.error('Signup error:', err.message);
    res.status(500).json({ message: 'Signup failed' });
  }
});


// Reserve order (customer or guest)
app.post('/api/reserve-order', async (req, res) => {
  console.log('Incoming order request:', req.body); 
  

  const { customer_id, items = [], guest_name = null, guest_contact = null } = req.body;
  console.log("👉 items received:", items);  // add this line

  // basic validation
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Missing items' });
  }

  const barcodeText = crypto.randomBytes(4).toString('hex');

  const total = items.reduce((sum, it) => sum + Number(it.price) * Number(it.quantity), 0);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO orders (user_id, total_price, guest_name, guest_contact, barcode)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [customer_id || null, total, guest_name, guest_contact, barcodeText]
    );
    const orderId = rows[0].id;

    const insertItemSQL = `
      INSERT INTO order_items (order_id, product_id, quantity, price)
      VALUES ($1, $2, $3, $4)
    `;
    for (const it of items) {
      await client.query(insertItemSQL, [orderId, it.product_id, it.quantity, it.price]);
    }

    await client.query('COMMIT');
    return res.json({ success: true, orderId, barcodeText });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('reserve-order error:', err);
    console.error('📛 Full stack:', err.stack);
    return res.status(500).json({ error: 'Order failed' });
  } finally {
    client.release();
  }
});




// Get all orders (grouped)
app.get('/api/orders', async (req, res) => {
  const { userId } = req.query;
  try {
    const result = await pool.query(
      `
      SELECT 
        o.id AS order_id,
        o.vendor_id,
        o.customer_id,
        o.barcode,
        o.guest_name,
        o.guest_contact,
        o.created_at,
        json_agg(json_build_object(
          'product_id', oi.product_id,
          'quantity', oi.quantity
        )) AS order_items
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE o.customer_id = $1
      GROUP BY o.id
      ORDER BY o.created_at DESC
      `,
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Fetch orders error:', err.message);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get order by ID
app.get('/api/orders/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `SELECT * FROM orders WHERE id = $1`,
      [id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Order fetch error:', err.message);
    res.status(500).json({ message: 'Server error' });
  }
});

// Forgot password
app.post('/api/forgot-password', async (req, res) => {
  const { email } = req.body;
  try {
    const result = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
    if (result.rows.length === 0) return res.status(404).json({ message: 'User not found' });

    const token = uuidv4();
    const resetLink = `${process.env.APP_BASE_URL}/reset-password?token=${token}`;
    console.log("👉 Reset email to:", email);
  console.log("👉 Reset link:", resetLink);
    await sendResetEmail(email, resetLink);

    res.json({ message: 'Password reset email sent' });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ message: 'Email failed' });
  }
});

// Secure password reset using token
app.post('/api/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword) {
    return res.status(400).json({ message: 'Token and new password required.' });
  }

  try {
    // Find user by valid token
    const userResult = await pool.query(
      `SELECT * FROM users WHERE reset_token = $1 AND reset_token_expires > NOW()`,
      [token]
    );

    if (userResult.rows.length === 0) {
      return res.status(400).json({ message: 'Invalid or expired token.' });
    }

    const user = userResult.rows[0];

    // Hash and update password
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await pool.query(
      `UPDATE users SET password = $1, reset_token = NULL, reset_token_expires = NULL WHERE id = $2`,
      [hashedPassword, user.id]
    );

    res.json({ message: 'Password updated successfully!' });
  } catch (err) {
    console.error('Reset error:', err.message);
    res.status(500).json({ message: 'Reset failed' });
  }
});


const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Backend server is running on port ${PORT}`);
});
