require('dotenv').config();
// 📧 Brevo setup
const SibApiV3Sdk = require('sib-api-v3-sdk');
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;
const tranEmailApi = new SibApiV3Sdk.TransactionalEmailsApi();

console.log("🔍 APP_BASE_URL from .env:", process.env.APP_BASE_URL);

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const express = require('express');
const cors = require('cors');
const pool = require('./db');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const sendResetEmail = require('./utils/sendEmail');

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

// ✅ Ensure DB schema
async function ensureSchema() {
  const sql = `
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) NOT NULL,
      email VARCHAR(100) NOT NULL UNIQUE,
      password TEXT NOT NULL,
      role VARCHAR(20) DEFAULT 'tenant',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS properties (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      description TEXT,
      monthly_rent  NUMERIC(10,2),
      landlord_id INTEGER REFERENCES users(id),
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS orders (
      id UUID PRIMARY KEY,
      tenant_id INTEGER,
      landlord_id INTEGER REFERENCES users(id),
      barcode TEXT,
      guest_name TEXT,
      guest_contact TEXT,
      monthly_rent  NUMERIC(10,2),
      status VARCHAR(20) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY,
      order_id UUID REFERENCES orders(id),
      property_id INTEGER REFERENCES properties(id),
      quantity INTEGER,
      monthly_rent  NUMERIC(10,2)
    );
  `;
  await pool.query(sql);
}
ensureSchema();

// ✅ Test route
app.get('/test', (req, res) => res.send('✅ Test route is working!'));

// ✅ Get all active properties
app.get('/api/properties', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.id, p.name, p.monthly_rent, p.description, p.landlord_id,
             u.username AS landlord_name
      FROM properties p
      JOIN users u ON p.landlord_id = u.id
      WHERE u.role = 'landlord' AND p.is_active = true
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});

// ✅ Add property (landlord only)
app.post('/api/properties', async (req, res) => {
  const { name, description, monthly_rent , landlord_id } = req.body;
  try {
    const roleCheck = await pool.query(
      'SELECT username, role FROM users WHERE id = $1',
      [landlord_id]
    );

    if (roleCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (roleCheck.rows[0].role !== 'landlord') {
      return res.status(403).json({ error: 'Only landlords can add properties' });
    }

    const result = await pool.query(
      `INSERT INTO properties (name, description, monthly_rent , landlord_id)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name, description, monthly_rent , landlord_id]
    );

    res.json({ message: "✅ Property added successfully", property: result.rows[0] });
  } catch (err) {
    console.error('Error inserting property:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ✅ Soft delete property
app.delete('/api/properties/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      'UPDATE properties SET is_active = false WHERE id = $1 RETURNING *',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Property not found or already deleted' });
    }
    res.json({ message: 'Property soft-deleted successfully', property: result.rows[0] });
  } catch (error) {
    console.error('Error soft-deleting property:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ✅ Search properties
app.get('/api/search', async (req, res) => {
  const search = (req.query.query || '').trim();
  if (!search) return res.json([]);
  try {
    const result = await pool.query(
      `SELECT p.id, p.name, p.monthly_rent , p.description, p.landlord_id, u.username AS landlord_name
       FROM properties p
       JOIN users u ON p.landlord_id = u.id
       WHERE p.name ILIKE $1 AND p.is_active = true`,
      [`%${search}%`]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ message: 'Search failed' });
  }
});

// ✅ Get landlord by name
app.get('/api/landlord/by-name/:landlordName', async (req, res) => {
  const { landlordName } = req.params;
  try {
    const result = await pool.query(
      `SELECT id, username AS name, email FROM users WHERE username = $1 AND role = 'landlord'`,
      [landlordName]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Landlord not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching landlord by name:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ✅ Get properties by landlord
app.get('/api/landlord/:landlordId/properties', async (req, res) => {
  const { landlordId } = req.params;
  try {
    const result = await pool.query(
      'SELECT * FROM properties WHERE landlord_id = $1 AND is_active = true',
      [landlordId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching landlord properties:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ✅ Login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: "Email and password required." });

  try {
    const result = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ message: "Email not found." });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ message: "Incorrect password." });

    res.json({ user: { id: user.id, username: user.username, email: user.email, role: user.role } });
  } catch (err) {
    console.error('🔥 Login error:', err.message);
    res.status(500).json({ message: "Server error during login." });
  }
});

// ✅ Signup
app.post('/api/signup', async (req, res) => {
  const { username, email, password, role } = req.body;
  try {
    const emailCheck = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]);
    if (emailCheck.rows.length > 0) {
      return res.status(400).json({ message: 'Email is already registered.' });
    }
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

// ✅ Landlord reservations
app.get('/api/landlord/:landlordId/reservations', async (req, res) => {
  const { landlordId } = req.params;
  try {
    const { rows } = await pool.query(
      `
      SELECT o.id AS id, o.guest_name, o.guest_contact, o.created_at, o.status,
             SUM(oi.monthly_rent * oi.quantity)::numeric(10, 2) AS monthly_rent,
             JSON_AGG(JSON_BUILD_OBJECT(
               'property_name', p.name,
               'monthly_rent', oi.monthly_rent,
               'quantity', oi.quantity
             )) AS items
      FROM orders o
      JOIN order_items oi ON o.id = oi.order_id
      JOIN properties p ON oi.property_id = p.id
      WHERE o.landlord_id = $1
      GROUP BY o.id, o.guest_name, o.guest_contact, o.created_at, o.status
      ORDER BY o.created_at DESC
      `,
      [landlordId]
    );
    res.json(rows);
  } catch (err) {
    console.error("❌ Error fetching landlord reservations:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ✅ Reserve property (tenant -> landlord)
app.post('/api/reserve-order', async (req, res) => {
  console.log('Incoming rental request:', req.body);

  const {
    tenant_id,
    userId,
    landlord_id,
    properties,
    items,
    guest_name,
    guestName,
    guest_contact,
    guestContact
  } = req.body;

  const actualTenantId = tenant_id ?? userId ?? null;
  const actualItems = properties ?? items ?? [];
  const actualGuestName = guest_name ?? guestName ?? null;
  const actualGuestContact = guest_contact ?? guestContact ?? null;

  if (!Array.isArray(actualItems) || actualItems.length === 0) {
    return res.status(400).json({ error: 'Missing properties' });
  }
  if (!landlord_id) return res.status(400).json({ error: 'Missing landlord_id' });

  const barcodeText = crypto.randomBytes(4).toString('hex');
  const total = actualItems.reduce(
    (sum, it) => sum + Number(it.monthly_rent) * Number(it.quantity),
    0
  );

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get landlord info
    const landlordResult = await client.query(
      'SELECT email, username FROM users WHERE id = $1 AND role = $2',
      [landlord_id, 'landlord']
    );
    const landlordEmail = landlordResult.rows[0]?.email;
    const landlordName = landlordResult.rows[0]?.username;

    // Insert reservation
    const { rows } = await client.query(
      `INSERT INTO reservations (guest_name, guest_contact, landlord_id, monthly_rent, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING id`,
      [actualGuestName, actualGuestContact, landlord_id, total]
    );
    const reservationId = rows[0].id;

    // Insert reservation items
    const insertItemSQL = `
      INSERT INTO reservation_items (reservation_id, property_id, quantity, monthly_rent)
      VALUES ($1, $2, $3, $4)
    `;
    for (const it of actualItems) {
      const propertyId = it.property_id ?? it.id;
      await client.query(insertItemSQL, [
        reservationId,
        propertyId,
        it.quantity,
        it.monthly_rent,
      ]);
    }

    await client.query('COMMIT');

    // 📤 Email landlord
    if (landlordEmail) {
      const emailBody = `
        <h2>New Rental Reservation</h2>
        <p><strong>Landlord:</strong> ${landlordName}</p>
        <p><strong>Guest:</strong> ${actualGuestName}</p>
        <p><strong>Contact:</strong> ${actualGuestContact}</p>
        <p><strong>Reservation ID:</strong> ${reservationId}</p>
        <p><strong>Barcode:</strong> ${barcodeText}</p>
        <p><strong>Total:</strong> $${total.toFixed(2)}</p>
      `;
      await tranEmailApi.sendTransacEmail({
        sender: { name: "Tajer Rentals", email: "support@tajernow.com" },
        to: [{ email: landlordEmail }],
        subject: "🏠 New Rental Reservation",
        htmlContent: emailBody,
      });
    }

    res.json({ success: true, reservationId, barcodeText });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ reserve-order error:', err.message);
    res.status(500).json({ error: 'Reservation failed' });
  } finally {
    client.release();
  }
});


// ✅ Get tenant orders
app.get('/api/orders', async (req, res) => {
  const { userId } = req.query;
  try {
    const result = await pool.query(
      `
      SELECT o.id AS order_id, o.landlord_id, o.tenant_id, o.barcode,
             o.guest_name, o.guest_contact, o.created_at,
             json_agg(json_build_object(
               'property_id', oi.property_id,
               'quantity', oi.quantity
             )) AS order_items
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE o.tenant_id = $1
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

// ✅ Forgot password
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

// ✅ Reset password
app.post('/api/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ message: 'Token and new password required.' });

  try {
    const userResult = await pool.query(
      `SELECT * FROM users WHERE reset_token = $1 AND reset_token_expires > NOW()`,
      [token]
    );
    if (userResult.rows.length === 0) {
      return res.status(400).json({ message: 'Invalid or expired token.' });
    }
    const user = userResult.rows[0];
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
  console.log(`✅ Backend server running on port ${PORT}`);
});
