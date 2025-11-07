const express = require("express");
const router = express.Router();
const pool = require("../db");
const sendRepairEmail = require("../utils/sendRepairEmail");

// ✅ Create repair request
router.post("/", async (req, res) => {
  try {
    const { description, image_urls, requester_email } = req.body;
    if (!description) return res.status(400).json({ error: "Description is required" });

    const result = await pool.query(
      `INSERT INTO repair_requests (description, image_urls, requester_email, status)
       VALUES ($1, $2, $3, 'open')
       RETURNING *`,
      [description, image_urls || [], requester_email]
    );

    if (requester_email) {
      await sendRepairEmail(requester_email, description, image_urls);
    }

    res.status(201).json({ success: true, repair: result.rows[0] });
  } catch (err) {
    console.error("Error creating repair request:", err);
    res.status(500).json({ error: "Failed to create repair request" });
  }
});

// ✅ Get all open requests
router.get("/open", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM repair_requests WHERE status = 'open' ORDER BY created_at DESC"
    );
    res.json({ success: true, repairs: result.rows });
  } catch (err) {
    console.error("Error fetching open repairs:", err);
    res.status(500).json({ error: "Failed to fetch open repair requests" });
  }
});

// ✅ Provider submits quote
router.post("/:id/quote", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      provider_email,
      provider_first_name,
      provider_last_name,
      provider_city,
      price_quote,
    } = req.body;

    // ✅ Just store provider info directly in the repair request
    const result = await pool.query(
      `UPDATE repair_requests
       SET provider_email = $1,
           provider_first_name = $2,
           provider_last_name = $3,
           provider_city = $4,
           price_quote = $5,
           status = 'quoted'
       WHERE id = $6
       RETURNING *`,
      [provider_email, provider_first_name, provider_last_name, provider_city, price_quote, id]
    );
    console.log("✅ Repair record updated:", result.rows[0]);


    if (result.rows.length === 0)
      return res.status(404).json({ error: "Repair request not found" });

    const repair = result.rows[0];

    // ✅ Notify requester with provider info (no email address)
    const requesterEmail = repair.requester_email;
    if (requesterEmail) {
      const providerDisplay = `${provider_first_name} ${provider_last_name} from ${provider_city}`;

      await sendRepairEmail(
        requesterEmail,
        `
        <p>Good news! ${providerDisplay} has submitted a quote of 
        <strong>$${price_quote}</strong> for your repair request.</p>

        <p><em>You won’t be charged until you mark your repair as completed after the provider finishes the job.</em></p>

        <p>Please choose an option below:</p>

      <a href="https://tajernow.com/checkout?repairId=${id}"
   style="background-color:#28a745;color:white;padding:10px 16px;
   border-radius:6px;text-decoration:none;margin-right:10px;">
   ✅ Accept Quote & Proceed to Payment
</a>


        <a href="${process.env.APP_BASE_URL}/api/repairs/${id}/reject"
           style="background-color:#dc3545;color:white;padding:10px 16px;
           border-radius:6px;text-decoration:none;">
           ❌ Reject Quote
        </a>
        `,
        repair.image_urls || []
      );

      console.log(`✅ Quote email sent to ${requesterEmail}`);
    }

    res.json({ success: true, repair });
  } catch (err) {
    console.error("Error submitting quote:", err);
    res.status(500).json({ error: "Failed to submit quote" });
  }
});


// ✅ Requester accepts quote
router.get("/:id/accept", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `UPDATE repair_requests
       SET status = 'accepted'
       WHERE id = $1
       RETURNING *`,
      [id]
    );

    if (result.rows.length === 0)
      return res.status(404).send("Repair request not found.");

    res.send(`<h2>✅ Quote Accepted</h2><p>Thank you! The provider will be notified.</p>`);
  } catch (err) {
    console.error("Error accepting quote:", err);
    res.status(500).send("Error accepting quote.");
  }
});

// ✅ Requester rejects quote
router.get("/:id/reject", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `UPDATE repair_requests
       SET status = 'rejected'
       WHERE id = $1
       RETURNING *`,
      [id]
    );

    if (result.rows.length === 0)
      return res.status(404).send("Repair request not found.");

    res.send(`<h2>❌ Quote Rejected</h2><p>The provider will be notified.</p>`);
  } catch (err) {
    console.error("Error rejecting quote:", err);
    res.status(500).send("Error rejecting quote.");
  }
});

const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ✅ Accept quote and redirect to Stripe
router.get("/payments/start/:id", async (req, res) => {
  try {
    const { id } = req.params;
    console.log("🚀 /payments/start called with ID:", id);

    // 1️⃣ Fetch repair details
    const result = await pool.query(
      `SELECT description, price_quote, requester_email 
       FROM repair_requests 
       WHERE id = $1`,
      [id]
    );
    const repair = result.rows[0];
    if (!repair) return res.status(404).send("Repair request not found.");

    // 2️⃣ Update status before redirect
    await pool.query(
      `UPDATE repair_requests
       SET status = 'accepted_pending_payment'
       WHERE id = $1`,
      [id]
    );

    // 3️⃣ Create Stripe Checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      customer_email: repair.requester_email,
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: `Repair: ${repair.description}` },
            unit_amount: Math.round(repair.price_quote * 100),
          },
          quantity: 1,
        },
      ],
      mode: "payment",
          success_url: `https://tajernow.com/payment-success?repairId=${id}`,
          cancel_url: `https://tajernow.com/payment-cancelled`,


      metadata: { repairId: id, repairType: "repair_request" },
    });

    // 👇 Add this console log to confirm Stripe URL
    console.log("💳 Stripe session created:", session.url);

    // 4️⃣ Redirect to Stripe
    res.redirect(session.url);
  } catch (err) {
    console.error("Error starting repair payment:", err.message);
    res.status(500).send("Failed to start repair payment.");
  }
});


module.exports = router;
