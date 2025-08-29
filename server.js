// Load .env only in development
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

const app = express();
app.use(cors());
app.use(express.json());






// --- Ensure DB schema exists on boot (idempotent) ---
async function ensureSchema() {
  const sql = `
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) NOT NULL,
    email VARCHAR(100) NOT NULL UNIQUE,
    password TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    role VARCHAR(50) DEFAULT 'customer'
  );

  CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    price NUMERIC(10,2) NOT NULL,
    stock INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    vendor_id INTEGER,
    vendor_name TEXT
  );

  CREATE TABLE IF NOT EXISTS carts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT carts_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS cart_items (
    id SERIAL PRIMARY KEY,
    cart_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    CONSTRAINT cart_items_cart_id_fkey
      FOREIGN KEY (cart_id) REFERENCES carts(id) ON DELETE CASCADE,
    CONSTRAINT cart_items_product_id_fkey
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS favorites (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT favorites_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT favorites_product_id_fkey
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
    CONSTRAINT favorites_unique UNIQUE (user_id, product_id)
  );

  CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    user_id INTEGER,
    status VARCHAR(20) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    total_price NUMERIC(10,2) DEFAULT 0,
    vendor_id INTEGER,
    guest_name TEXT,
    guest_contact TEXT
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id SERIAL PRIMARY KEY,
    order_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    price NUMERIC(10,2) NOT NULL DEFAULT 0,
    CONSTRAINT order_items_order_id_fkey
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
    CONSTRAINT order_items_product_id_fkey
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS password_resets (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    token VARCHAR(255) NOT NULL UNIQUE,
    expires_at TIMESTAMP NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reservations (
    id SERIAL PRIMARY KEY,
    product_id INTEGER NOT NULL,
    guest_name VARCHAR(100),
    guest_contact VARCHAR(150),
    quantity INTEGER,
    reservation_code VARCHAR(50) UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT reservations_product_id_fkey
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
  );
  `;
  await pool.query(sql);
  console.log('✅ DB schema ensured');
}

ensureSchema().catch((e) => console.error('Schema init failed:', e));

// Stripe routes (mounted after JSON middleware)
app.use('/api/payment', require('./routes/payment'));

const saltRounds = 10; // still here if you use it later

// PRODUCTS
app.get('/api/products', async (req, res) => {
  try {
    const search = (req.query.search || '').trim();
    let result;

    if (search) {
      result = await pool.query(
        `
        SELECT p.id, p.name, p.price, p.description,
               u.username AS vendor_name
        FROM products p
        LEFT JOIN users u ON p.vendor_id = u.id
        WHERE p.name ILIKE $1 OR p.description ILIKE $1
        ORDER BY p.name ASC
        `,
        [`%${search}%`]
      );
    } else {
      result = await pool.query(
        `
        SELECT p.id, p.name, p.price, p.description,
               u.username AS vendor_name
        FROM products p
        LEFT JOIN users u ON p.vendor_id = u.id
        ORDER BY p.name ASC
        `
      );
    }

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({ message: 'Failed to fetch products' });
  }
});

// SIGNUP
app.post('/api/signup', async (req, res) => {
  const { username, password, email, role = 'customer' } = req.body;

  try {
    console.log('Request received at signup endpoint:', req.body);

    if (role !== 'vendor' && role !== 'customer') {
      return res.status(400).json({ message: 'Invalid role. Role must be "vendor" or "customer".' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await pool.query(
      'INSERT INTO users (username, password, email, role) VALUES ($1, $2, $3, $4)',
      [username, hashedPassword, email, role]
    );

    res.status(201).json({ message: 'User registered successfully!' });
  } catch (error) {
    console.error('Error registering user:', error);
    if (error.code === '23505') {
      return res.status(400).json({ message: 'Email or username already exists.' });
    }
    res.status(500).json({ message: 'Error registering user.' });
  }
});

// FAVORITES
app.post('/api/favorites', async (req, res) => {
  const { userId, productId } = req.body;
  try {
    await pool.query(
      'INSERT INTO favorites (user_id, product_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [userId, productId]
    );
    res.status(201).json({ message: 'Product added to favorites' });
  } catch (error) {
    console.error('Error adding favorite:', error);
    res.status(500).json({ message: 'Failed to add to favorites' });
  }
});

app.get('/api/favorites/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const result = await pool.query(
      `
      SELECT products.*
      FROM favorites
      JOIN products ON favorites.product_id = products.id
      WHERE favorites.user_id = $1
      `,
      [userId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching favorites:', error);
    res.status(500).json({ message: 'Failed to fetch favorites' });
  }
});

// LOGIN
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const user = userResult.rows[0];
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ message: 'Incorrect password.' });
    }

    res.status(200).json({
      message: 'Login successful.',
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ message: 'Server error during login.' });
  }
});

// ADD PRODUCT
app.post('/api/products', async (req, res) => {
  const { name, price, description, vendor_id, vendor_name } = req.body;

  if (!vendor_id || !vendor_name) {
    return res.status(400).json({ message: 'Missing vendor information.' });
  }

  try {
    await pool.query(
      `INSERT INTO products (name, price, description, vendor_id, vendor_name)
       VALUES ($1, $2, $3, $4, $5)`,
      [name, price, description, vendor_id, vendor_name]
    );

    res.status(201).json({ message: 'Product added successfully.' });
  } catch (error) {
    console.error('Error adding product:', error);
    res.status(500).json({ message: 'Failed to add product.' });
  }
});

// SEARCH
app.get('/api/search', async (req, res) => {
  const { query } = req.query;
  try {
    const result = await pool.query(
      `SELECT p.id, p.name, p.price, p.description,
              u.username AS vendor_name
       FROM products p
       LEFT JOIN users u ON p.vendor_id = u.id
       WHERE p.name ILIKE $1 OR p.description ILIKE $1
       ORDER BY p.name ASC
       LIMIT 50`,
      [`%${(query || '').toLowerCase()}%`]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error searching products:', error);
    res.status(500).json({ message: 'Failed to search products' });
  }
});

// ORDERS (customer)
app.post('/api/orders', async (req, res) => {
  const { userId, cartItems, totalPrice } = req.body;
  if (!userId || typeof userId !== 'number') {
    return res.status(400).json({ message: 'Invalid or missing userId.' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO orders (user_id, total_price) VALUES ($1, $2) RETURNING id',
      [userId, totalPrice]
    );
    const orderId = result.rows[0].id;

    const orderItemsQueries = cartItems.map((item) =>
      pool.query(
        'INSERT INTO order_items (order_id, product_id, quantity, price) VALUES ($1, $2, $3, $4)',
        [orderId, item.id, item.quantity, item.price]
      )
    );
    await Promise.all(orderItemsQueries);

    res.status(201).json({ message: 'Order placed successfully!', orderId });
  } catch (error) {
    console.error('Error saving order:', error);
    res.status(500).json({ message: 'Failed to place order.' });
  }
});

// VENDOR ORDERS
app.get('/api/vendor-orders', async (req, res) => {
  const { vendorId } = req.query;
  if (!vendorId) return res.status(400).json({ message: 'Missing vendorId' });

  try {
    const result = await pool.query(
      `SELECT o.id AS order_id,
              o.status,
              o.total_price,
              o.created_at,
              COALESCE(o.guest_name, u.username) AS customer_name,
              COALESCE(o.guest_contact, 'N/A') AS contact,
              json_agg(json_build_object(
                  'product_id', oi.product_id,
                  'quantity', oi.quantity,
                  'price', oi.price
              )) AS items
       FROM orders o
       JOIN order_items oi ON o.id = oi.order_id
       LEFT JOIN users u ON o.user_id = u.id
       WHERE o.vendor_id = $1
       GROUP BY o.id, u.username, o.guest_name, o.guest_contact
       ORDER BY o.created_at DESC`,
      [vendorId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching vendor orders:', error);
    res.status(500).json({ message: 'Failed to fetch vendor orders' });
  }
});

// VENDOR RESERVATIONS
app.get('/api/vendor/:vendorId/reservations', async (req, res) => {
  try {
    const { vendorId } = req.params;
    const result = await pool.query(
      `SELECT
          o.id AS order_id,
          o.status,
          o.total_price,
          o.created_at,
          COALESCE(o.guest_name, u.username) AS customer_name,
          COALESCE(o.guest_contact, 'N/A') AS contact,
          json_agg(
            json_build_object(
              'product_id', oi.product_id,
              'product_name', p.name,
              'quantity', oi.quantity,
              'price', oi.price
            )
            ORDER BY oi.id
          ) AS items
       FROM orders o
       JOIN order_items oi ON o.id = oi.order_id
       JOIN products p ON p.id = oi.product_id
       LEFT JOIN users u ON o.user_id = u.id
       WHERE o.vendor_id = $1
       GROUP BY o.id, u.username, o.guest_name, o.guest_contact
       ORDER BY o.created_at DESC`,
      [vendorId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching vendor reservations:", error);
    res.status(500).json({ message: "Failed to fetch reservations" });
  }
});

// RESERVE ORDER (guest support)
app.post('/api/reserve-order', async (req, res) => {
  try {
    const { products, guestName, guestContact, userId } = req.body;
    if (!products || !Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ message: 'No products provided.' });
    }

    const effectiveUserId = (typeof userId === 'number' || typeof userId === 'string')
      ? Number(userId)
      : null;

    await pool.query('BEGIN');

    const { rows: prodVendor } = await pool.query(
      'SELECT vendor_id FROM products WHERE id = $1',
      [products[0].id]
    );
    if (prodVendor.length === 0) throw new Error('Invalid product_id (no vendor found).');
    const vendorId = prodVendor[0].vendor_id;

    const orderInsert = await pool.query(
      `INSERT INTO orders (user_id, vendor_id, guest_name, guest_contact, status, total_price)
       VALUES ($1, $2, $3, $4, 'pending', 0)
       RETURNING id`,
      [effectiveUserId, vendorId, guestName || null, guestContact || null]
    );
    const orderId = orderInsert.rows[0].id;

    const itemValues = [];
    const itemParams = [];
    let i = 1;
    let totalCents = 0;

    products.forEach((p) => {
      const qty = Number(p.quantity || 1);
      const price = Number(p.price || 0);
      if (!Number.isFinite(qty) || qty <= 0) throw new Error('Invalid quantity');
      if (!Number.isFinite(price) || price < 0) throw new Error('Invalid price');

      const priceCents = Math.round(price * 100);
      totalCents += priceCents * qty;

      itemValues.push(`($${i++}, $${i++}, $${i++}, $${i++})`);
      itemParams.push(orderId, p.id, qty, price);
    });

    await pool.query(
      `INSERT INTO order_items (order_id, product_id, quantity, price)
       VALUES ${itemValues.join(',')}`,
      itemParams
    );

    const totalPrice = (totalCents / 100).toFixed(2);
    await pool.query(`UPDATE orders SET total_price = $1 WHERE id = $2`, [totalPrice, orderId]);

    const orderCode = `Spark-${uuidv4().slice(0, 8)}`;
    bwipjs.toBuffer(
      { bcid: 'code128', text: orderCode, scale: 3, height: 10, includetext: true },
      async (err, png) => {
        await pool.query('COMMIT');

        if (err) {
          console.error('Barcode error:', err);
          return res.status(201).json({
            message: 'Reservation created (barcode generation failed).',
            orderId,
            orderCode,
            total: totalPrice,
            barcode: null,
            customerName: guestName || null,
            customerContact: guestContact || null,
          });
        }

        const barcodeImage = `data:image/png;base64,${png.toString('base64')}`;
        return res.status(201).json({
          message: 'Reservation successful!',
          orderId,
          orderCode,
          total: totalPrice,
          barcode: barcodeImage,
          customerName: guestName || null,
          customerContact: guestContact || null,
        });
      }
    );
  } catch (e) {
    console.error('reserve-order error:', e);
    try { await pool.query('ROLLBACK'); } catch {}
    return res.status(500).json({
      message: e?.detail || e?.message || 'Failed to create reservation order.'
    });
  }
});

// VENDOR PRODUCTS
app.get("/api/vendor/:vendorId/products", async (req, res) => {
  const vendorId = req.params.vendorId;
  try {
    const result = await pool.query(
      "SELECT * FROM products WHERE vendor_id = $1",
      [vendorId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching vendor products:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// PASSWORD RESET
app.post('/api/forgot-password', async (req, res) => {
  const { email } = req.body;
  try {
    const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const token = uuidv4();
    const expiresAt = new Date(Date.now() + 3600000); // 1 hour

    await pool.query(
      'INSERT INTO password_resets (email, token, expires_at) VALUES ($1, $2, $3)',
      [email, token, expiresAt]
    );

    const resetLink = `${process.env.REACT_APP_API_URL}/reset-password?token=${token}`;
    console.log(`Password reset link: ${resetLink}`);

    res.status(200).json({ message: 'Password reset link sent!' });
  } catch (error) {
    console.error('Error in forgot password:', error);
    res.status(500).json({ message: 'Server error. Please try again later.' });
  }
});

app.post('/api/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  try {
    const tokenResult = await pool.query(
      'SELECT * FROM password_resets WHERE token = $1 AND expires_at > NOW()',
      [token]
    );
    if (tokenResult.rows.length === 0) {
      return res.status(400).json({ message: 'Invalid or expired token.' });
    }

    const email = tokenResult.rows[0].email;
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await pool.query('UPDATE users SET password = $1 WHERE email = $2', [hashedPassword, email]);
    await pool.query('DELETE FROM password_resets WHERE token = $1', [token]);

    res.status(200).json({ message: 'Password reset successful!' });
  } catch (error) {
    console.error('Error in reset password:', error);
    res.status(500).json({ message: 'Server error. Please try again later.' });
  }
});

// CHECK EMAIL
app.get('/api/check-email', async (req, res) => {
  const { email } = req.query;
  try {
    const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    res.json({ exists: userResult.rows.length > 0 });
  } catch (err) {
    console.error('Error checking email:', err.message);
    res.status(500).json({ message: 'Server error' });
  }
});

// USER ORDERS
app.get('/api/orders', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ message: 'Missing userId.' });

  try {
    const result = await pool.query(
      `SELECT o.id AS order_id, o.total_price, o.created_at, 
              json_agg(json_build_object(
                  'product_id', oi.product_id,
                  'quantity', oi.quantity,
                  'price', oi.price
              )) AS items
       FROM orders o
       JOIN order_items oi ON o.id = oi.order_id
       WHERE o.user_id = $1
       GROUP BY o.id
       ORDER BY o.created_at DESC`,
      [userId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching user orders:', error);
    res.status(500).json({ message: 'Failed to fetch orders.' });
  }
});

// ---- Start server (use Render's PORT) ----
const PORT = process.env.PORT || 5002;
app.listen(PORT, () => {
  console.log(`✅ Backend server is running on port ${PORT}`);
});

module.exports = app;
