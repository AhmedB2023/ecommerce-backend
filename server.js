require("dotenv").config();

/* =======================
   CORE SETUP
======================= */
const express = require("express");
const app = express();
const path = require("path");
const cors = require("cors");
const bodyParser = require("body-parser");

/* =======================
   DATABASE
======================= */
const pool = require("./db");
const db = require("./db");

/* =======================
   STRIPE
======================= */
const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

/* =======================
   CLOUDINARY
======================= */
const cloudinary = require("cloudinary").v2;
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/* =======================
   BREVO (Sendinblue)
======================= */
const SibApiV3Sdk = require("sib-api-v3-sdk");
const defaultClient = SibApiV3Sdk.ApiClient.instance;
defaultClient.authentications["api-key"].apiKey = process.env.BREVO_API_KEY;
const tranEmailApi = new SibApiV3Sdk.TransactionalEmailsApi();

/* =======================
   OTHER LIBS
======================= */
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");

/* =======================
   STRIPE WEBHOOKS (MUST BE FIRST)
======================= */
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  (req, res) => {
    const sig = req.headers["stripe-signature"];
    const event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    console.log("EVENT TYPE:", event.type);
    res.sendStatus(200);
  }
);


app.post(
  "/webhook/connected",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET_CONNECTED
      );
    } catch (err) {
      console.error("❌ Webhook signature failed:", err.message);
      return res.sendStatus(400);
    }

    if (event.type === "account.updated") {
      const account = event.data.object;

      if (account.capabilities?.transfers === "active") {
        console.log("🎉 Provider onboarded:", account.id);

        const { rows } = await pool.query(
          `
          SELECT * FROM repair_requests
          WHERE provider_stripe_account = $1
            AND completion_status = 'user_confirmed'
            AND payout_released_at IS NULL
          `,
          [account.id]
        );

        for (const repair of rows) {
          if (!repair.payment_intent_id) continue;

          const amount = Math.round(Number(repair.final_price) * 0.9 * 100);

          await stripe.transfers.create({
            amount,
            currency: "usd",
            destination: account.id,
            source_transaction: repair.payment_intent_id,
          });

          await pool.query(
            `UPDATE repair_requests
             SET payout_released_at = NOW()
             WHERE id = $1`,
            [repair.id]
          );

          console.log("💸 Payout released:", repair.id);
        }
      }
    }

    res.sendStatus(200);
  }
);

/* =======================
   JSON + CORS (AFTER WEBHOOKS)
======================= */
app.use(express.json());

const allowedOrigins = [
  "https://tajernow.com",
  "http://localhost:3000",
  "https://ecommerce-backend-y3v4.onrender.com",
];

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) cb(null, true);
      else cb(new Error("CORS blocked"));
    },
    credentials: true,
  })
);

/* =======================
   STATIC FILES
======================= */
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

/* =======================
   ROUTES (UNCHANGED)
======================= */
const repairRoutes = require("./routes/repairs");
app.use("/api/repairs", repairRoutes);

const availabilityRoutes = require("./routes/availabilityRoutes");
app.use("/api", availabilityRoutes);

const idUploadRoutes = require("./routes/idUpload");
app.use("/api", idUploadRoutes);

/* =======================
   HEALTH CHECK
======================= */
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

/* =======================
   STRIPE RETURN / REFRESH
======================= */
app.get("/stripe-refresh", (req, res) => {
  res.send("Stripe refresh page");
});

app.get("/stripe-return", (req, res) => {
  res.send("Stripe onboarding complete");
});













const multer = require("multer");


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
    price NUMERIC(10,2),
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
    price,
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
    !price ||
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
        (title, type_of_space, price_per, price, length, width, height, landlord_id, street_address, city, state, zipcode)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        title,
        type_of_space,
        price_per,
        price,
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


   // ✅ Upload images to Cloudinary instead of local uploads
for (const file of files) {
  const result = await cloudinary.uploader.upload(file.path, {
    folder: "tajer_properties", // optional folder name on Cloudinary
  });

  const imageUrl = result.secure_url;

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
// ✅ Create Checkout Session (secure & with 5% service fee)
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const { propertyId, tenantEmail, reservationId } = req.body;

    // Basic validation
    if (!tenantEmail || !propertyId || !reservationId) {
      return res.status(400).json({
        error: "Missing required fields (propertyId, reservationId, tenantEmail)",
      });
    }

    // 1️⃣ Query property/reservation details (including ID upload field)
    const result = await db.query(
      `SELECT 
         p.is_active, 
         p.price, 
         r.status AS reservation_status, 
         r.property_id,
         r.id_front_url
       FROM properties p
       LEFT JOIN reservations r ON r.id = $2
       WHERE p.id = $1`,
      [propertyId, reservationId]
    );

    const row = result.rows[0];
    if (!row) {
      return res.status(404).json({ error: "Property or reservation not found" });
    }

    // 2️⃣ Property must be available
    if (!row.is_active) {
      return res.status(400).json({ error: "This property is no longer available." });
    }

    // 3️⃣ Only allow payment if:
    //   - Reservation status is 'accepted_pending_verification'
    //   - AND ID has been uploaded
    if (
      row.reservation_status !== "accepted_pending_verification" ||
      !row.id_front_url
    ) {
      return res.status(400).json({
        error: "This reservation is not ready for payment or has already been processed.",
      });
    }

    // 4️⃣ Use price from DB and calculate service fee and total (secure)
   const propertyPrice = Number(row.price);  // <-- Always convert to Number!
if (!propertyPrice || propertyPrice <= 0) {
  return res.status(400).json({ error: "Invalid property price" });
}


    // Calculate service fee (5%) and total (round to 2 decimals)
    const serviceFee = Math.round(propertyPrice * 0.05 * 100) / 100;
    const total = Math.round((propertyPrice + serviceFee) * 100) / 100;

    console.log(
      "✅ Charging property",
      propertyId,
      "for",
      total,
      "USD (price:",
      propertyPrice,
      "| fee:",
      serviceFee,
      ")"
    );

    // 5️⃣ Add metadata for webhook tracking
    const metadata = { 
      reservationId: reservationId.toString(),
      propertyPrice: propertyPrice.toString(),
      serviceFee: serviceFee.toString()
    };

   // 6️⃣ Create Stripe checkout session with secure, verified total amount
const session = await stripe.checkout.sessions.create({
  payment_method_types: ["card"],
  customer_email: tenantEmail,

  // ⭐ APPLICATION FEE ADDED ⭐
  payment_intent_data: {
    application_fee_amount: Math.round(total * 0.10 * 100) // 10% fee
  },

  metadata: {
    reservationId: reservationId.toString(),
    propertyPrice: propertyPrice.toString(),
    serviceFee: serviceFee.toString()
  },

  line_items: [
    {
      price_data: {
        currency: "usd",
        product_data: {
          name: `Reservation Payment for Property #${propertyId}`,
        },
        unit_amount: Math.round(total * 100), // Stripe requires cents
      },
      quantity: 1,
    },
  ],

  mode: "payment",
  success_url: `${process.env.APP_BASE_URL}/payment-success`,
  cancel_url: `${process.env.APP_BASE_URL}/payment-cancel`,
});


    // 7️⃣ Return session link
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
    // Optional: lower the similarity threshold if you want broader matches
    await pool.query(`SET pg_trgm.similarity_threshold = 0.2`);

   const result = await pool.query(
  `
  SELECT 
    p.id, 
    p.title,  
    p.price,
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
    COALESCE(a.start_date, NULL) AS start_date,
    COALESCE(a.end_date, NULL) AS end_date
  FROM properties p
  JOIN users u ON p.landlord_id = u.id
  LEFT JOIN availability a ON a.property_id = p.id
  WHERE p.is_active = true AND (
    LOWER(p.city) LIKE LOWER($1) || '%' OR
    LOWER(p.title) LIKE '%' || LOWER($1) || '%' OR
    LOWER(p.description) LIKE '%' || LOWER($1) || '%' OR
    p.zipcode = $1
  )
  GROUP BY p.id, u.username, a.start_date, a.end_date
  ORDER BY p.created_at DESC
  LIMIT 20;
  `,
  [query]
);


    const properties = result.rows;

    const propertyIds = properties.map(p => p.id);
    let imageMap = {};

    if (propertyIds.length > 0) {
      const imageResults = await pool.query(
        `SELECT property_id, image_url FROM property_images WHERE property_id = ANY($1)`,
        [propertyIds]
      );

      imageResults.rows.forEach(img => {
        if (!imageMap[img.property_id]) {
          imageMap[img.property_id] = [];
        }
        imageMap[img.property_id].push(img.image_url);
      });
    }

  const withImages = properties.map(p => {
  const imageList = imageMap[p.id] || [];
  return {
    ...p,
    image_url: imageList.length > 0 ? imageList[0] : null, // ✅ first image only
    images: imageList, // keep the array in case you need it later
  };
});

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
  r.offer_amount AS price,  -- ✅ rename offer_amount as price
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
  console.log("✅ Tenant ID received from frontend:", req.body.tenant_id || req.body.userId);


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
     (tenant_id, guest_name, guest_contact, landlord_id, property_id, quantity, offer_amount, reservation_code, created_at, start_date, end_date)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9, $10)
   RETURNING id`,
  [
    actualTenantId,        // ✅ tenant_id
    actualGuestName,
    actualGuestContact,
    landlord_id,
    propertyId,
    quantity,
    actualOfferAmount,
    barcodeText,
    req.body.start_date,
    req.body.end_date,
  ]
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




// ✅ Get all reservations for a specific tenant (updated)
app.get('/api/reservations', async (req, res) => {
  const { tenantId } = req.query;

  if (!tenantId) {
    return res.status(400).json({ error: 'tenantId is required' });
  }

  try {
   const { rows } = await pool.query(
  `
  SELECT r.id, r.property_id, r.status, r.offer_amount, r.created_at,
         p.title, p.street_address, p.city, p.state, p.zipcode,
         p.price, p.price_per,
         ARRAY_AGG(pi.image_url) AS images
  FROM reservations r
  JOIN properties p ON r.property_id = p.id
  LEFT JOIN property_images pi ON pi.property_id = p.id
  WHERE r.tenant_id = $1
  GROUP BY r.id, p.title, p.street_address, p.city, p.state, p.zipcode, p.price, p.price_per
  ORDER BY r.created_at DESC;
  `,
  [tenantId]
);


    res.json(rows);
  } catch (err) {
    console.error('Error fetching tenant reservations:', err.message);
    res.status(500).json({ error: 'Failed to fetch reservations' });
  }
});



// ✅ Create checkout session for repair requests
app.post("/api/repairs/create-checkout-session", async (req, res) => {
  try {
    const { repairId, customerEmail, customerAddress, preferredTime, amount } = req.body;

    if (!repairId || !customerEmail || !amount) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      customer_email: customerEmail,
      metadata: {
        repairId: repairId.toString(),
        repairType: "repair_request",
        customerAddress,
        preferredTime,
      },
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `Repair Request #${repairId}`,
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

    res.json({ url: session.url });
  } catch (error) {
    console.error("❌ Repair checkout error:", error.message);
    res.status(500).json({ error: "Failed to create repair checkout session" });
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

// GET /api/hosts/:slug
app.get("/api/hosts/:slug", async (req, res) => {
  const { slug } = req.params;

  try {
    // 1️⃣ Get the host by slug
    const hostResult = await pool.query(
      "SELECT id, username, email, role FROM users WHERE slug = $1 AND role = 'landlord'",
      [slug]
    );

    if (hostResult.rows.length === 0) {
      return res.status(404).json({ error: "Host not found" });
    }

    const host = hostResult.rows[0];

    // 2️⃣ Get all properties by this host
    const propertiesResult = await pool.query(
      "SELECT * FROM properties WHERE landlord_id = $1",
      [host.id]
    );

    // 3️⃣ Send both host info and properties
    res.json({
      host,
      properties: propertiesResult.rows,
    });
  } catch (err) {
    console.error("Error fetching host:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ POST /api/lead
app.post("/api/lead", async (req, res) => {
  try {
    const { name, email, phone, propertyType, location } = req.body;

    // Basic validation
    if (!name || !email) {
      return res.status(400).json({ error: "Name and email are required." });
    }

    // Insert the lead into a new table
    const result = await pool.query(
      `INSERT INTO leads (name, email, phone, property_type, location)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [name, email, phone, propertyType, location]
    );
   

   // ✅ Send Brevo email notification
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications["api-key"];
apiKey.apiKey = process.env.BREVO_API_KEY;

const tranEmailApi = new SibApiV3Sdk.TransactionalEmailsApi();
const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();

// ✅ Make sure both sender and recipient are valid
sendSmtpEmail.sender = { email: "support@tajernow.com", name: "Tajer Leads" };
sendSmtpEmail.to = [{ email: process.env.EMAIL_USER || "support@tajernow.com" }];
sendSmtpEmail.replyTo = { email }; // user's email from the form

sendSmtpEmail.subject = "🚀 New Tajer Hosting Lead";
sendSmtpEmail.htmlContent = `
  <h3>New Host Lead on Tajer</h3>
  <p><strong>Name:</strong> ${name}</p>
  <p><strong>Email:</strong> ${email}</p>
  <p><strong>Phone:</strong> ${phone || "N/A"}</p>
  <p><strong>Type of Space:</strong> ${propertyType || "N/A"}</p>
  <p><strong>Location:</strong> ${location || "N/A"}</p>
`;

await tranEmailApi.sendTransacEmail(sendSmtpEmail);
res.status(201).json({ message: "Lead saved", leadId: result.rows[0].id });

  } catch (err) {
    console.error("Error saving lead:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// 📩 CONTACT FORM ROUTE
app.post("/api/contact", async (req, res) => {
  try {
    const { name, email, message } = req.body;
    if (!name || !email || !message) {
      return res.status(400).json({ error: "All fields are required" });
    }

    // Import Brevo SDK
    const SibApiV3Sdk = require("sib-api-v3-sdk");
    const defaultClient = SibApiV3Sdk.ApiClient.instance;
    const apiKey = defaultClient.authentications["api-key"];
    apiKey.apiKey = process.env.BREVO_API_KEY;

    // Create Brevo instance
    const tranEmailApi = new SibApiV3Sdk.TransactionalEmailsApi();
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();

    sendSmtpEmail.subject = `📬 New Contact Message from ${name}`;
    sendSmtpEmail.to = [{ email: process.env.EMAIL_USER }];
    sendSmtpEmail.htmlContent = `
      <h3>New Contact Message</h3>
      <p><strong>Name:</strong> ${name}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Message:</strong></p>
      <p>${message}</p>
    `;
    sendSmtpEmail.sender = { email: "support@tajernow.com", name: "Tajer Support" };

    await tranEmailApi.sendTransacEmail(sendSmtpEmail);
    res.json({ success: true, message: "Message sent successfully!" });
  } catch (error) {
    console.error("❌ Error sending contact email:", error);
    res.status(500).json({ error: "Failed to send message" });
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

app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Tajer backend is alive!' });
});

// ... all your routes above ...

app.get("/stripe-refresh", (req, res) => {
  res.send("Stripe refresh page - link expired, please request a new one.");
});

app.get("/stripe-return", (req, res) => {
  res.send("Stripe onboarding complete!");
});





const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Backend server running on port ${PORT}`);
});
