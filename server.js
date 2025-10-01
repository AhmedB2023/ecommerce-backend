require('dotenv').config();
const express = require('express');
const app = express(); // ✅ MISSING BEFORE
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// 📧 Brevo setup
const SibApiV3Sdk = require('sib-api-v3-sdk');
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;
const tranEmailApi = new SibApiV3Sdk.TransactionalEmailsApi();
const sendEmail = require('./utils/sendEmail');

// 🧳 File upload setup
const multer = require('multer');
const path = require('path');

// ✅ Serve uploaded images statically
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ✅ Store images to /uploads folder with unique names
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    const uniqueName = Date.now() + '-' + file.originalname;
    cb(null, uniqueName);
  }
});

const upload = multer({ storage });




console.log("🔍 APP_BASE_URL from .env:", process.env.APP_BASE_URL);

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}


const cors = require('cors');
const pool = require('./db');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const sendResetEmail = require('./utils/sendEmail');



const allowedOrigins = ['https://tajernow.com', 'http://localhost:3000'];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("CORS not allowed"));
    }
  },
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS",
  allowedHeaders: "Content-Type,Authorization",
  credentials: true,
}));

app.options('*', cors());
app.use(express.json());

// ✅ Clean Real Estate Reservation Schema
async function ensureSchema() {
  const sql = `
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) NOT NULL,
      email VARCHAR(100) NOT NULL UNIQUE,
      password TEXT NOT NULL,
      role VARCHAR(20) DEFAULT 'tenant',  -- roles: 'tenant' or 'landlord'
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS properties (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      description TEXT,
      min_price NUMERIC(10,2),               -- Minimum expected rent
      max_price NUMERIC(10,2),               -- Maximum expected rent
      num_bedrooms INTEGER,
      num_bathrooms INTEGER,
      landlord_id INTEGER REFERENCES users(id),
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS property_images (
      id SERIAL PRIMARY KEY,
      property_id INTEGER REFERENCES properties(id) ON DELETE CASCADE,
      image_url TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reservations (
      id SERIAL PRIMARY KEY,
      property_id INTEGER REFERENCES properties(id) ON DELETE CASCADE,
      guest_name VARCHAR(100),
      guest_contact VARCHAR(150),
      offer_amount NUMERIC(10,2),            -- Tenant's proposed rent
      reservation_code VARCHAR(50) UNIQUE,
      landlord_id INTEGER REFERENCES users(id),
      status VARCHAR(20) DEFAULT 'pending',  -- pending, accepted, rejected
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS favorites (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      property_id INTEGER REFERENCES properties(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS password_resets (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      token TEXT NOT NULL,
      expires_at TIMESTAMP NOT NULL
    );
  `;

  await pool.query(sql);
}

ensureSchema();




app.post('/api/properties', upload.array('images'), async (req, res) => {
  const {
    name,
    description,
    min_price,
    max_price,
    num_bedrooms,
    num_bathrooms,
    landlord_id,
    street_address,
    city,
    state,
    zipcode,
  } = req.body;

  const files = req.files;

  if (!name || !min_price || !max_price || !landlord_id || !street_address || !city || !state || !zipcode) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

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

    // ✅ Insert property with address fields
    const result = await pool.query(
      `INSERT INTO properties 
       (name, description, min_price, max_price, num_bedrooms, num_bathrooms, landlord_id, street_address, city, state, zipcode)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [name, description, min_price, max_price, num_bedrooms, num_bathrooms, landlord_id, street_address, city, state, zipcode]
    );

    const property = result.rows[0];

    // ✅ Save images in property_images table
    for (const file of files) {
      const fakeUrl = `https://ecommerce-backend-y3v4.onrender.com/uploads/${file.filename}`;
      await pool.query(
        `INSERT INTO property_images (property_id, image_url)
         VALUES ($1, $2)`,
        [property.id, fakeUrl]
      );
    }

    res.json({ message: "✅ Property added with address + images", property });
  } catch (err) {
    console.error('❌ Error inserting property:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ✅ Get all active properties (with landlord, address, and images)
app.get('/api/properties', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        p.id, 
        p.name, 
        p.min_price, 
        p.max_price,
        p.description, 
        p.num_bedrooms,
        p.num_bathrooms,
        p.street_address,
        p.city,
        p.state,
        p.zipcode,
        p.landlord_id,
        u.username AS landlord_name
      FROM properties p
      JOIN users u ON p.landlord_id = u.id
      WHERE u.role = 'landlord' AND p.is_active = true
    `);

    const properties = result.rows;

    // Fetch all images
    const imageResults = await pool.query(`
      SELECT property_id, image_url 
      FROM property_images
    `);

    // Group images by property_id
    const imageMap = {};
    imageResults.rows.forEach(img => {
      if (!imageMap[img.property_id]) {
        imageMap[img.property_id] = [];
      }
      imageMap[img.property_id].push(img.image_url);
    });

    // Attach image arrays to properties
    const withImages = properties.map(p => ({
      ...p,
      images: imageMap[p.id] || []
    }));

    res.json(withImages);
  } catch (err) {
    console.error("❌ Error in /api/properties:", err.message);
    res.status(500).send('Server error');
  }
});

// ✅ Get one property by ID (with landlord info)
app.get('/api/properties/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `SELECT 
        p.*, 
        u.username AS landlord_name
      FROM properties p
      JOIN users u ON p.landlord_id = u.id
      WHERE p.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Property not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});


// ✅ Create Payment Intent
app.post('/api/create-payment-intent', async (req, res) => {
  const { amount, currency } = req.body;

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount,          // in cents (e.g., $10 = 1000)
      currency,        // "usd"
      automatic_payment_methods: { enabled: true },
    });

    res.send({
      clientSecret: paymentIntent.client_secret,
    });
  } catch (err) {
    console.error("❌ Payment error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Get all images for a property
app.get('/api/properties/:id/images', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      'SELECT image_url FROM property_images WHERE property_id = $1',
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});
// ✅ Create Checkout Session
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const { propertyId, amount, tenantEmail } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Invalid payment amount" });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      customer_email: tenantEmail,
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `Reservation Payment for Property #${propertyId}`,
            },
            unit_amount: Math.round(amount * 100), // cents
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: `${process.env.APP_BASE_URL}/payment-success`,
      cancel_url: `${process.env.APP_BASE_URL}/payment-cancel`,
    });

    res.json({ id: session.id, url: session.url });
  } catch (error) {
    console.error("❌ Stripe error:", error.message);
    res.status(500).json({ error: "Payment session failed" });
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

app.get('/api/search', async (req, res) => {
  const query = req.query.query?.trim();

  if (!query) {
    return res.status(400).json({ error: 'Missing search query' });
  }

  try {
    const result = await pool.query(`
      SELECT 
        p.id, 
        p.name, 
        p.min_price, 
        p.max_price,
        p.description, 
        p.num_bedrooms,
        p.num_bathrooms,
        p.street_address,
        p.city,
        p.state,
        p.zipcode,
        p.landlord_id,
        u.username AS landlord_name
      FROM properties p
      JOIN users u ON p.landlord_id = u.id
      WHERE p.is_active = true AND (
        LOWER(p.city) LIKE LOWER($1) OR
        p.zipcode = $2
      )
    `, [`%${query}%`, query]);

    const properties = result.rows;

    // Fetch all images
    const imageResults = await pool.query(`
      SELECT property_id, image_url 
      FROM property_images
    `);

    const imageMap = {};
    imageResults.rows.forEach(img => {
      if (!imageMap[img.property_id]) {
        imageMap[img.property_id] = [];
      }
      imageMap[img.property_id].push(img.image_url);
    });

    const withImages = properties.map(p => ({
      ...p,
      images: imageMap[p.id] || []
    }));

    res.json(withImages);
  } catch (err) {
    console.error("❌ Error in /api/search:", err.message);
    res.status(500).json({ error: "Server error" });
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


// ✅ Get all reservations for a landlord (with auto-expire after 72 hours)
app.get('/api/landlord/:landlordId/reservations', async (req, res) => {
  const { landlordId } = req.params;

  try {
    // ✅ Auto-expire reservations older than 72 hours
    await pool.query(`
      UPDATE reservations
      SET status = 'expired'
      WHERE status = 'pending'
        AND landlord_id = $1
        AND created_at < NOW() - INTERVAL '72 hours'
    `, [landlordId]);

    // ✅ Fetch updated list
    const { rows } = await pool.query(`
      SELECT 
        r.id,
        r.guest_name,
        r.guest_contact,
        r.created_at,
        r.quantity,
        r.status,
        r.offer_amount,
        p.name AS property_name
      FROM reservations r
      JOIN properties p ON r.property_id = p.id
      WHERE r.landlord_id = $1
      ORDER BY r.created_at DESC
    `, [landlordId]);

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
    guestContact,
    offer_amount, // 👈 Make sure this comes from the frontend
  } = req.body;

  const actualTenantId = tenant_id ?? userId ?? null;
  const actualItems = properties ?? items ?? [];
  const actualGuestName = guest_name ?? guestName ?? null;
  const actualGuestContact = guest_contact ?? guestContact ?? null;
  const actualOfferAmount = offer_amount ?? 0;

  if (!Array.isArray(actualItems) || actualItems.length === 0) {
    return res.status(400).json({ error: 'Missing properties' });
  }
  if (!landlord_id) {
    return res.status(400).json({ error: 'Missing landlord_id' });
  }

  const barcodeText = crypto.randomBytes(4).toString('hex');

  // ✅ Use first property from the array (since we support only 1 now)
  const property = actualItems[0];
  const propertyId = property.property_id ?? property.id;
  const quantity = property.quantity ?? 1;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 🔍 Get landlord info
    const landlordResult = await client.query(
      'SELECT email, username FROM users WHERE id = $1 AND role = $2',
      [landlord_id, 'landlord']
    );
    const landlordEmail = landlordResult.rows[0]?.email;
    const landlordName = landlordResult.rows[0]?.username;

    // ✅ Insert directly into reservations with offer_amount
    const { rows } = await client.query(
      `INSERT INTO reservations 
         (guest_name, guest_contact, landlord_id, property_id, quantity, offer_amount, reservation_code, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       RETURNING id`,
      [actualGuestName, actualGuestContact, landlord_id, propertyId, quantity, actualOfferAmount, barcodeText]
    );

    const reservationId = rows[0].id;
    // 📧 Send email confirmation to guest
if (actualGuestContact && actualGuestContact.includes('@')) {
  try {
    const subject = "Reservation Submitted – Pending Landlord Approval";
    const text = `Hi ${actualGuestName || 'there'},\n\nThank you for submitting your reservation request.\n\n` +
                 `Your offer of $${Number(actualOfferAmount).toFixed(2)} has been sent to the landlord.\n\n` +
                 `You will receive another email once the landlord accepts your offer and approves checkout.\n\n` +
                 `Reservation ID: ${reservationId}\n\nThank you,\nTajer Rentals`;

    await tranEmailApi.sendTransacEmail({
      sender: { name: "Tajer Rentals", email: "support@tajernow.com" },
      to: [{ email: actualGuestContact }], // ✅ FIXED here
      subject,
      textContent: text, // ✅ textContent for plain emails (vs. htmlContent)
    });
  } catch (emailErr) {
    console.error("❌ Failed to send reservation confirmation email:", emailErr.message);
  }
}



    await client.query('COMMIT');

    // 📧 Notify landlord
    if (landlordEmail) {
      const emailBody = `
        <h2>New Rental Reservation</h2>
        <p><strong>Landlord:</strong> ${landlordName}</p>
        <p><strong>Guest:</strong> ${actualGuestName}</p>
        <p><strong>Contact:</strong> ${actualGuestContact}</p>
        <p><strong>Reservation ID:</strong> ${reservationId}</p>
        <p><strong>Barcode:</strong> ${barcodeText}</p>
        <p><strong>Offer Amount:</strong> $${Number(actualOfferAmount).toFixed(2)}</p>
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


// Update reservation status + notify guest (email)
app.put('/api/reservations/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const allowed = ['accepted', 'rejected', 'docs_requested'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  const FRONTEND_URL = process.env.FRONTEND_URL || 'https://tajernow.com';

  try {
    const { rows } = await pool.query(
      `UPDATE reservations 
       SET status = $1 
       WHERE id = $2 
       RETURNING id, status, guest_name, guest_contact`,
      [status, id]
    );

    if (!rows.length) return res.status(404).json({ error: 'Reservation not found' });

    const reservation = rows[0];

    // Send email if guest_contact looks like an email
    if (reservation.guest_contact && reservation.guest_contact.includes('@')) {
      let subject = `Reservation Status: ${status.toUpperCase()}`;
      let text = `Hi ${reservation.guest_name || 'there'},\n\nYour reservation status is now: ${status.toUpperCase()}.`;

      if (status === 'accepted') {
        // ✅ Direct link to guest checkout page
        text += `\n\n✅ Complete your reservation and (if required) upload your ID here:\n${FRONTEND_URL}/checkout/${reservation.id}\n\nThis secure link will take you to payment.`;
      } else if (status === 'rejected') {
        text += `\n\n❌ Unfortunately, your reservation was not accepted this time.`;
      } else if (status === 'docs_requested') {
        text += `\n\n📑 Additional documents are required. Please use this link to upload them:\n${FRONTEND_URL}/checkout/${reservation.id}`;
      }

      text += `\n\nThank you,\nTajer Team`;
      console.log("📤 Sending to:", reservation.guest_contact);

      try {
      await sendEmail({
  to: [{ email: reservation.guest_contact }],  // ✅ Correct format
  subject,
  text,
});


      } catch (err) {
        console.error('Email sending failed:', err.message);
      }
    }

    res.json(reservation);
  } catch (e) {
    console.error('update status error:', e.message);
    res.status(500).json({ error: 'Failed to update status' });
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
