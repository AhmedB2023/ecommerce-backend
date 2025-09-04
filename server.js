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

const app = express();
app.use(cors());
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
      SELECT p.id, p.name, p.price, p.description, 
             u.username AS vendor_name
      FROM products p
      JOIN users u ON p.vendor_id = u.id
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
      `SELECT p.id, p.name, p.price, p.description, u.username AS vendor_name
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
      `SELECT * FROM products WHERE vendor_id = $1`,
      [vendorId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching vendor products:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Register route
app.post('/api/register', async (req, res) => {
  const { username, email, password, role } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (username, email, password, role)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [username, email, hashedPassword, role || 'customer']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Registration error');
  }
});

// Login route
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ message: 'Invalid credentials' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ message: 'Invalid credentials' });

    res.json({ id: user.id, username: user.username, role: user.role });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Login error');
  }
});

// Reserve order (customer or guest)
app.post('/api/reserve-order', async (req, res) => {
  const { customer_id, vendor_id, items, guest_name, guest_contact } = req.body;
  const orderId = uuidv4();
  const barcodeText = orderId.slice(0, 8);

  try {
    await pool.query(
      `INSERT INTO orders (id, customer_id, vendor_id, barcode, guest_name, guest_contact)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [orderId, customer_id || null, vendor_id, barcodeText, guest_name, guest_contact]
    );

    for (const item of items) {
      await pool.query(
        `INSERT INTO order_items (order_id, product_id, quantity)
         VALUES ($1, $2, $3)`,
        [orderId, item.product_id, item.quantity]
      );
    }

    res.status(201).json({ message: 'Order reserved', orderId, barcode: barcodeText });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ message: 'Order failed' });
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
    await sendResetEmail(email, resetLink);

    res.json({ message: 'Password reset email sent' });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ message: 'Email failed' });
  }
});

// Reset password
app.post('/api/reset-password', async (req, res) => {
  const { email, newPassword } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await pool.query(`UPDATE users SET password = $1 WHERE email = $2`, [hashedPassword, email]);
    res.json({ message: 'Password updated' });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ message: 'Reset failed' });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Backend server is running on port ${PORT}`);
});
