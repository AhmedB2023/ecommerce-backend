const express = require('express');
const cors = require('cors');
const pool = require('./db');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const bwipjs = require('bwip-js');
require('dotenv').config();



const app = express();
app.use(cors());
app.use(express.json());
app.use('/api/payment', require('./routes/payment'));


const saltRounds = 10; // Number of salt rounds for password hashing

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
        JOIN users u ON p.vendor_id = u.id
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
        JOIN users u ON p.vendor_id = u.id
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


// Signup endpoint
app.post('/api/signup', async (req, res) => {
    const { username, password, email, role = 'customer' } = req.body; // Include role with default value

    try {
        console.log('Request received at signup endpoint:', req.body); // Debugging log

        // Validate role
        if (role !== 'vendor' && role !== 'customer') {
            return res.status(400).json({ message: 'Invalid role. Role must be "vendor" or "customer".' });
        }

        // Hash the password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Insert user into the database with the role
        await pool.query(
            'INSERT INTO users (username, password, email, role) VALUES ($1, $2, $3, $4)',
            [username, hashedPassword, email, role]
        );

        res.status(201).json({ message: 'User registered successfully!' });
    } catch (error) {
        console.error('Error registering user:', error);

        // Handle unique constraint violation (duplicate email or username)
        if (error.code === '23505') {
            return res.status(400).json({ message: 'Email or username already exists.' });
        }

        res.status(500).json({ message: 'Error registering user.' });
    }
});

// POST /api/favorites - Add product to favorites
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


app.post('/api/login', async (req, res) => {
    const { email, password } = req.body; // Expect email instead of username

    try {
        console.log('Login request:', { email, password });

        // Find the user in the database using email
        const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        console.log("Database result:", userResult.rows);

        if (userResult.rows.length === 0) {
            console.error('User not found');
            return res.status(404).json({ message: 'User not found.' });
        }

        const user = userResult.rows[0];
        console.log('User from DB:', user);

        // Verify the password
        const isPasswordValid = await bcrypt.compare(password, user.password);
        console.log('Password validation result:', isPasswordValid);

        if (!isPasswordValid) {
            console.error('Incorrect password');
            return res.status(401).json({ message: 'Incorrect password.' });
        }

        // Include the role in the response
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

// add products to database
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

// Get favorites by user ID
app.get('/api/favorites/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const result = await pool.query(`
      SELECT products.*
      FROM favorites
      JOIN products ON favorites.product_id = products.id
      WHERE favorites.user_id = $1
    `, [userId]);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching favorites:', error);
    res.status(500).json({ message: 'Failed to fetch favorites' });
  }
});


// Save Order Route
app.post('/api/orders', async (req, res) => {
    console.log('Request Body:', req.body); // Log the incoming request body for debugging

    const { userId, cartItems, totalPrice } = req.body;

    if (!userId || typeof userId !== 'number') {
        return res.status(400).json({ message: 'Invalid or missing userId.' });
    }

    try {
        // Insert the order into the database
        const result = await pool.query(
            'INSERT INTO orders (user_id, total_price) VALUES ($1, $2) RETURNING id',
            [userId, totalPrice]
        );

        const orderId = result.rows[0].id;
        console.log('Order ID:', orderId); // Log the order ID for debugging

        // Insert each cart item into the order_items table
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

// Search products endpoint (with vendor info)
app.get('/api/search', async (req, res) => {
  const { query } = req.query; // Extract the search query
  console.log("Search Query:", query);

  try {
    const result = await pool.query(
      `SELECT p.id, p.name, p.price, p.description,
              u.username AS vendor_name
       FROM products p
       JOIN users u ON p.vendor_id = u.id
       WHERE p.name ILIKE $1 OR p.description ILIKE $1
       ORDER BY p.name ASC
       LIMIT 50`,
      [`%${query.toLowerCase()}%`]
    );

    console.log("Search Results:", result.rows);
    res.json(result.rows);
  } catch (error) {
    console.error('Error searching products:', error);
    res.status(500).json({ message: 'Failed to search products' });
  }
});
// Get all orders for a specific vendor
app.get('/api/vendor-orders', async (req, res) => {
  const { vendorId } = req.query;

  if (!vendorId) {
    return res.status(400).json({ message: 'Missing vendorId' });
  }

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

app.get("/api/vendor/:vendorId/reservations", async (req, res) => {
  try {
    const { vendorId } = req.params;
    console.log("📦 Vendor reservations requested for:", vendorId);
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
          'product_name', p.name,           -- ✅ show name instead of "Product #17"
          'quantity', oi.quantity,
          'price', oi.price
        )
        ORDER BY oi.id
      ) AS items
   FROM orders o
   JOIN order_items oi ON o.id = oi.order_id
   JOIN products p ON p.id = oi.product_id      -- ✅ join products
   LEFT JOIN users u ON o.user_id = u.id
   WHERE o.vendor_id = $1
   GROUP BY o.id, u.username, o.guest_name, o.guest_contact
   ORDER BY o.created_at DESC`,
  [vendorId]
);




    console.log("📦 Reservations query result:", result.rows);
    res.json(result.rows);

  } catch (error) {
    console.error("Error fetching vendor reservations:", error);
    res.status(500).json({ message: "Failed to fetch reservations" });
  }
});



app.post('/api/reserve-order', async (req, res) => {
  try {
    const { products, guestName, guestContact, userId } = req.body;

    // 1) Validate products
    if (!products || !Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ message: 'No products provided.' });
    }

    // 2) Determine effective user
    //    If you allow true guests, keep "null" here (after the DB change).
    //    If you must keep NOT NULL, set this to your dedicated GUEST user id, e.g., 999.
    const effectiveUserId = (typeof userId === 'number' || typeof userId === 'string')
      ? Number(userId)
      : null; // <= recommended (with nullable user_id)

    await pool.query('BEGIN');

    // 3) Vendor from first product
    const { rows: prodVendor } = await pool.query(
      'SELECT vendor_id FROM products WHERE id = $1',
      [products[0].id]
    );
    if (prodVendor.length === 0) {
      throw new Error('Invalid product_id (no vendor found).');
    }
    const vendorId = prodVendor[0].vendor_id;

    // 4) Create order (now storing guest_name/contact)
    const orderInsert = await pool.query(
      `
      INSERT INTO orders (user_id, vendor_id, guest_name, guest_contact, status, total_price)
      VALUES ($1, $2, $3, $4, 'pending', 0)
      RETURNING id
      `,
      [effectiveUserId, vendorId, guestName || null, guestContact || null]
    );
    const orderId = orderInsert.rows[0].id;

    // 5) Insert items
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

    // 6) Update total
    const totalPrice = (totalCents / 100).toFixed(2);
    await pool.query(`UPDATE orders SET total_price = $1 WHERE id = $2`, [totalPrice, orderId]);

    // 7) Barcode (unchanged)
    const orderCode = `Spark-${uuidv4().slice(0, 8)}`;
    bwipjs.toBuffer(
      {
        bcid: 'code128',
        text: orderCode,
        scale: 3,
        height: 10,
        includetext: true,
      },
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
            customerName: guestName || null,        // helpful for UI
            customerContact: guestContact || null,  // helpful for UI
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
// Example: GET /api/vendor/:vendorId/products
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


app.post('/api/forgot-password', async (req, res) => {
    const { email } = req.body;

    try {
        // Check if the user exists
        const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userResult.rows.length === 0) {
            return res.status(404).json({ message: 'User not found.' });
        }

        // Generate reset token and expiration
        const token = uuidv4();
        const expiresAt = new Date(Date.now() + 3600000); // 1 hour from now

        // Save the token in the database
        await pool.query(
            'INSERT INTO password_resets (email, token, expires_at) VALUES ($1, $2, $3)',
            [email, token, expiresAt]
        );

        // Simulate sending email (log reset link)
        const resetLink = `http://localhost:5002/reset-password?token=${token}`;
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
        // Check if the token exists and is valid
        const tokenResult = await pool.query(
            'SELECT * FROM password_resets WHERE token = $1 AND expires_at > NOW()',
            [token]
        );

        if (tokenResult.rows.length === 0) {
            return res.status(400).json({ message: 'Invalid or expired token.' });
        }

        const email = tokenResult.rows[0].email;

        // Hash the new password
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        // Update the user's password
        await pool.query('UPDATE users SET password = $1 WHERE email = $2', [hashedPassword, email]);

        // Delete the used token
        await pool.query('DELETE FROM password_resets WHERE token = $1', [token]);

        res.status(200).json({ message: 'Password reset successful!' });
    } catch (error) {
        console.error('Error in reset password:', error);
        res.status(500).json({ message: 'Server error. Please try again later.' });
    }
});
// Check if email exists endpoint
app.get('/api/check-email', async (req, res) => {
    const { email } = req.query;

    try {
        const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);

        if (userResult.rows.length > 0) {
            res.json({ exists: true });
        } else {
            res.json({ exists: false });
        }
    } catch (err) {
        console.error('Error checking email:', err.message);
        res.status(500).json({ message: 'Server error' });
    }
});
// Get orders for a specific user
app.get('/api/orders', async (req, res) => {
    const { userId } = req.query;

    if (!userId) {
        return res.status(400).json({ message: 'Missing userId.' });
    }

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



// Start the server
const PORT = 5002; // Use a different port
app.listen(PORT, () => {
    console.log(`Backend server is running on http://localhost:${PORT}`);
});
