require('dotenv').config();
const express = require('express');
const app = express(); // ✅ MISSING BEFORE
// Stripe raw body middleware
const bodyParser = require("body-parser");

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// 📧 Brevo setup
const SibApiV3Sdk = require('sib-api-v3-sdk');
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;
const tranEmailApi = new SibApiV3Sdk.TransactionalEmailsApi();
const sendEmail = require('./utils/sendEmail');

app.post("/webhook", bodyParser.raw({ type: "application/json" }), async (req, res) => {
  console.log("🔥 Stripe webhook called");

  const sig = req.headers["stripe-signature"];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ✅ Handle successful checkout session
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const reservationId = session.metadata?.reservationId;

    if (!reservationId) {
      console.error("⚠️ No reservationId in metadata");
      return res.status(400).send("Missing reservationId");
    }

    try {
      // 1. Update reservation status to 'accepted'
      const result = await db.query(
        "UPDATE reservations SET status = 'accepted' WHERE id = $1 RETURNING *",
        [reservationId]
      );
      const reservation = result.rows[0];

      if (!reservation) {
        console.warn("⚠️ Reservation not found:", reservationId);
        return res.status(404).send("Reservation not found");
      }

      // 2. Get landlord email
      const landlordResult = await db.query(
        "SELECT email FROM users WHERE id = $1",
        [reservation.landlord_id]
      );
      const landlordEmail = landlordResult.rows[0]?.email;

      // 3. Guest email comes from guest_contact (if it's an email format)
      const tenantEmail = reservation.guest_contact;

      // 4. Send confirmation emails (Brevo integration)
      const sender = { name: "Tajer", email: "support@tajernow.com" };

      const emailPromises = [];

      if (tenantEmail?.includes("@")) {
        emailPromises.push(
          tranEmailApi.sendTransacEmail({
            sender,
            to: [{ email: tenantEmail }],
            subject: "Your Reservation is Confirmed!",
            htmlContent: `<p>Thank you for your payment. Your reservation for property #${reservation.property_id} has been confirmed.</p>`
          })
        );
      }

      if (landlordEmail) {
        emailPromises.push(
          tranEmailApi.sendTransacEmail({
            sender,
            to: [{ email: landlordEmail }],
            subject: "New Reservation Confirmed",
            htmlContent: `<p>A new reservation has been accepted for your property #${reservation.property_id}. Please check your dashboard for details.</p>`
          })
        );
      }

      await Promise.all(emailPromises);
      console.log("✅ Emails sent to tenant and landlord.");
    } catch (err) {
      console.error("❌ Error processing webhook:", err.message);
      return res.status(500).send("Webhook processing error");
    }
  }

  res.status(200).json({ received: true });
});


const db = require('./db');






app.use(express.json());
const cors = require('cors');
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



// 🧳 File upload setup
const multer = require('multer');
const path = require('path');

// ✅ Serve uploaded images statically
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ✅ Mount availability routes here
const availabilityRoutes = require('./routes/availabilityRoutes');
app.use('/api', availabilityRoutes);

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


// ✅ Add this line to mount the route
const idUploadRoutes = require('./routes/idUpload');
app.use('/api', idUploadRoutes);


console.log("🔍 APP_BASE_URL from .env:", process.env.APP_BASE_URL);

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}



const pool = require('./db');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const sendResetEmail = require('./utils/sendEmail');






// ✅ Clean Real Estate Reservation Schema
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
    min_price NUMERIC(10,2),
    max_price NUMERIC(10,2),
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
    offer_amount NUMERIC(10,2),
    reservation_code VARCHAR(50) UNIQUE,
    landlord_id INTEGER REFERENCES users(id),
    status VARCHAR(20) DEFAULT 'pending',
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

  -- ✅ New: property availability table
  CREATE TABLE IF NOT EXISTS property_availability (
    id SERIAL PRIMARY KEY,
    property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    day DATE NOT NULL,
    is_available BOOLEAN NOT NULL DEFAULT TRUE,
    note TEXT,
    UNIQUE(property_id, day)
  );

  CREATE INDEX IF NOT EXISTS idx_prop_avail_prop_day
    ON property_availability(property_id, day);
`;


  await pool.query(sql);
}

ensureSchema();




app.post('/api/properties', upload.array('images'), async (req, res) => {
  const {
    title,
    type_of_space,
    price_per,
    min_price,
    max_price,
    length,
    width,
    height,
    landlord_id,
    street_address,
    city,
    state,
    zipcode,
  } = req.body;

  const files = req.files;

  // ✅ Validate all required fields
  if (
    !title ||
    !type_of_space ||
    !price_per ||
    !min_price ||
    !max_price ||
    !length ||
    !width ||
    !height ||
    !landlord_id ||
    !street_address ||
    !city ||
    !state ||
    !zipcode
  ) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // ✅ Check if landlord exists and has proper role
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

    // ✅ Insert property into the database
    const result = await pool.query(
      `INSERT INTO properties 
        (title, type_of_space, price_per, min_price, max_price, length, width, height, landlord_id, street_address, city, state, zipcode)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        title,
        type_of_space,
        price_per,
        min_price,
        max_price,
        length,
        width,
        height,
        landlord_id,
        street_address,
        city,
        state,
        zipcode
      ]
    );

    const property = result.rows[0];

    const { start_date, end_date } = req.body;

await pool.query(
  `INSERT INTO availability (property_id, start_date, end_date)
   VALUES ($1, $2, $3)`,
  [property.id, start_date, end_date || null] // use null for open-ended
);


    // ✅ Save uploaded images to property_images table
    for (const file of files) {
      const imageUrl = `https://ecommerce-backend-y3v4.onrender.com/uploads/${file.filename}`;
      await pool.query(
        `INSERT INTO property_images (property_id, image_url)
         VALUES ($1, $2)`,
        [property.id, imageUrl]
      );
    }

    res.json({ message: '✅ Property added with full details and images', property });
  } catch (err) {
    console.error('❌ Error inserting property:', err.message);
    res.status(500).json({ error: 'Server error' });
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
    const { propertyId, amount, tenantEmail, reservationId } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Invalid payment amount" });
    }

    if (!tenantEmail || !propertyId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Safely add metadata
    const metadata = {};
    if (reservationId) metadata.reservationId = reservationId.toString();

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      customer_email: tenantEmail,
      metadata,
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `Reservation Payment for Property #${propertyId}`,
            },
            unit_amount: Math.round(amount * 100), // Stripe requires amount in cents
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: `${process.env.APP_BASE_URL}/payment-success`,
      cancel_url: `${process.env.APP_BASE_URL}/payment-cancel`,
    });

    return res.json({ id: session.id, url: session.url });
  } catch (error) {
    console.error("❌ Stripe error:", error.message);
    return res.status(500).json({ error: "Payment session failed" });
  }
});
// ✅ Get single property by ID
app.get('/api/properties/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `SELECT 
         p.*, 
         u.username AS landlord_name
       FROM properties p
       JOIN users u ON p.landlord_id = u.id
       WHERE p.id = $1 AND p.is_active = true`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Property not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("❌ Error fetching property by ID:", err.message);
    res.status(500).json({ error: "Internal server error" });
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
    // Get matching properties
   const result = await pool.query(`
  SELECT 
    p.id, 
    p.title, 
    p.min_price, 
    p.max_price,
    p.description, 
    p.num_bedrooms,
    p.num_bathrooms,
    p.street_address,
    p.city,
    p.state,
    p.zipcode,
    p.length,
    p.width,
    p.height,
    p.type_of_space,
    p.price_per,
    p.landlord_id,
    u.username AS landlord_name,
    a.start_date,
    a.end_date
  FROM properties p
  JOIN users u ON p.landlord_id = u.id
  LEFT JOIN availability a ON p.id = a.property_id
  WHERE p.is_active = true AND (
    LOWER(p.city) LIKE LOWER($1) OR
    p.zipcode = $2
  )
`, [`%${query}%`, query]);

    const properties = result.rows;

    // ✅ Only fetch images for matched property IDs
    const propertyIds = properties.map(p => p.id);

    let imageMap = {};
    if (propertyIds.length > 0) {
      const imageResults = await pool.query(
        `SELECT property_id, image_url FROM property_images WHERE property_id = ANY($1)`,
        [propertyIds]
      );

      // Group images by property_id
      imageResults.rows.forEach(img => {
        if (!imageMap[img.property_id]) {
          imageMap[img.property_id] = [];
        }
        imageMap[img.property_id].push(img.image_url);
      });
    }

    // Attach images to properties
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
    const result = await pool.query(`
  SELECT 
    p.*,
    a.start_date,
    a.end_date,
    a.is_available
  FROM properties p
  LEFT JOIN availability a ON p.id = a.property_id
  WHERE p.landlord_id = $1 AND p.is_active = true
`, [landlordId]);

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
        r.id_verified,
        p.title AS property_name
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
             `Reservation ID: ${reservationId}\n` +
             `Barcode: ${barcodeText}\n\n` +
             `Thank you,\nTajer Rentals`;

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

// ✅ Get reservation by ID (for guest checkout)
app.get('/api/reservations/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM reservations WHERE id = $1`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Reservation not found" });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error("Error fetching reservation:", err.message);
    res.status(500).json({ error: "Failed to fetch reservation" });
  }
});

// Update reservation status + notify guest (email)
app.put('/api/reservations/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const allowed = [
    'accepted',
    'accepted_pending_verification',
    'rejected',
    'docs_requested'
  ];

  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const FRONTEND_URL = process.env.FRONTEND_URL || 'https://tajernow.com';

  try {
    const { rows } = await pool.query(
      `UPDATE reservations 
       SET status = $1 
       WHERE id = $2 
       RETURNING id, status, guest_name, guest_contact, landlord_id`,
      [status, id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Reservation not found' });
    }

    const reservation = rows[0];
    // If the new status is accepted_pending_verification, reject all other pending reservations for the same property
//if (status === 'accepted_pending_verification') {
  //const { rows: rejectedRows } = await pool.query(
    //`UPDATE reservations
    // SET status = 'rejected'
    // WHERE property_id = (
    //   SELECT property_id FROM reservations WHERE id = $1
     //)
    // AND status = 'pending'
    // AND id != $1
    // RETURNING id, guest_name, guest_contact`,
   // [id]
  //);

  // Send rejection emails to those tenants
  //for (const r of rejectedRows) {
   // if (r.guest_contact && r.guest_contact.includes('@')) {
    //  await tranEmailApi.sendTransacEmail({
     //   sender: { name: 'Tajer Rentals', email: 'support@tajernow.com' },
     //   to: [{ email: r.guest_contact }],
     //   subject: 'Reservation not accepted',
    //    textContent: `Hi ${r.guest_name || 'there'},\n\n❌ Unfortunately, your reservation was not accepted this time.\n\nThank you,\nTajer Team`,
    //  });
   // }
  //}
//}


    // Only send emails if guest_contact looks like an email
    if (reservation.guest_contact && reservation.guest_contact.includes('@')) {
      let subject;
      let text;

      if (status === 'accepted_pending_verification') {
        subject = 'Reservation accepted – pending ID verification';
        text = `Hi ${reservation.guest_name || 'there'},

Your reservation has been accepted by the landlord, but before it can be finalized, we need to verify your ID.

Please upload your ID using the secure link below:
${FRONTEND_URL}/checkout/${reservation.id}

Once your ID is verified, we’ll notify you and the landlord.

Thank you,
Tajer Team`;
      } else if (status === 'accepted') {
        subject = 'Reservation fully accepted';
        text = `Hi ${reservation.guest_name || 'there'},

✅ Your ID has been verified and your reservation is now fully accepted.

You're all set! We’ve confirmed everything with the landlord.

Thanks for using Tajer — your space is officially reserved.

Tajer Team`;

        // ✅ Notify the landlord too
        const landlordRes = await pool.query(
          `SELECT email FROM users WHERE id = $1`,
          [reservation.landlord_id]
        );
        const landlordEmail = landlordRes.rows?.[0]?.email;

        if (landlordEmail) {
          const landlordText = `Hi,

Tenant ${reservation.guest_name} has successfully uploaded their ID, and it has been verified ✅.

The tenant has completed payment, and the reservation is now fully accepted.

You’ll receive your payout automatically.

Tajer Team`;

          await tranEmailApi.sendTransacEmail({
            sender: { name: 'Tajer Rentals', email: 'support@tajernow.com' },
            to: [{ email: landlordEmail }],
            subject: 'Tenant verified and reservation accepted',
            textContent: landlordText,
          });
        }
      } else if (status === 'rejected') {
        subject = 'Reservation not accepted';
        text = `Hi ${reservation.guest_name || 'there'},

❌ Unfortunately, your reservation was not accepted this time.

Thank you,
Tajer Team`;
      } else if (status === 'docs_requested') {
        subject = 'Additional documents required';
        text = `Hi ${reservation.guest_name || 'there'},

📑 Additional documents are required. Please use this link to upload them:
${FRONTEND_URL}/checkout/${reservation.id}

Thank you,
Tajer Team`;
      }

      // ✅ Send guest email
      if (subject && text) {
        console.log('📤 Sending to guest:', reservation.guest_contact);

        await tranEmailApi.sendTransacEmail({
          sender: { name: 'Tajer Rentals', email: 'support@tajernow.com' },
          to: [{ email: reservation.guest_contact }],
          subject,
          textContent: text,
        });
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
