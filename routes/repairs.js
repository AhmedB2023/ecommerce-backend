const express = require("express");
const router = express.Router();
const pool = require("../db");
const { sendRepairEmail } = require('../utils/sendRepairEmail');


const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);



// ✅ Create repair request
router.post("/", async (req, res) => {
  try {
    const { 
      description, 
      image_urls, 
      requester_email, 
      customer_address, 
      preferred_time 
    } = req.body;
    console.log("🔥 Preferred time received by backend:", req.body.preferred_time);


    // 🛑 Required field validation
    if (!description || !customer_address || !preferred_time) {
      return res.status(400).json({ 
        error: "Description, address, and preferred time are required." 
      });
    }

    // ✅ Generate unique job code
const jobCode = 'R-' + Math.floor(100000 + Math.random() * 900000);

const result = await pool.query(
  `INSERT INTO repair_requests 
    (description, image_urls, requester_email, customer_address, preferred_time, status, job_code)
   VALUES ($1, $2, $3, $4, $5, 'open', $6)
   RETURNING *`,
  [description, image_urls || [], requester_email, customer_address, preferred_time, jobCode]
);

if (requester_email) {
  await sendRepairEmail(
    requester_email,
    `
      <h2>Your repair request has been received!</h2>
      <p><strong>Job Code:</strong> ${jobCode}</p>
      <p><strong>Description:</strong> ${description}</p>
      <p><strong>Preferred Time:</strong> ${preferred_time}</p>
      <p>You’ll need this Job Code later to check your repair status or mark it as completed.</p>
    `,
    image_urls
  );
}


    res.status(201).json({ success: true, repairId: result.rows[0].id });

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

    // ✅ Update repair request with provider info
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
      [
        provider_email,
        provider_first_name,
        provider_last_name,
        provider_city,
        price_quote,
        id,
      ]
    );

    if (result.rows.length === 0)
      return res.status(404).json({ error: "Repair request not found" });

    const repair = result.rows[0];
    console.log("✅ Repair record updated:", repair);

    // ✅ Notify requester with provider info
    const requesterEmail = repair.requester_email;
    if (requesterEmail) {
      const providerDisplay = `${provider_first_name} ${provider_last_name} from ${provider_city}`;

      await sendRepairEmail(
        requesterEmail,
        `
        <p>You received a new quote from ${providerDisplay} for your repair request. 
The quoted price is <strong>$${price_quote}</strong>.</p>


        <p><em>You won’t be charged until you mark your repair as completed after the provider finishes the job.</em></p>

        <p>Please choose an option below:</p>

        <a href="${process.env.APP_BASE_URL}/repair-checkout?repairId=${id}"
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

    // ✅ Send provider a confirmation + job code email
    if (provider_email) {
      await sendRepairEmail(
        provider_email,
        `
          <h3>Your quote has been submitted successfully!</h3>
          <p>Keep this Job Code safe — you’ll need it later to mark the job as completed.</p>
          <p><strong>Job Code:</strong> ${repair.job_code}</p>
          <p>We’ll notify you once the customer has made payment and you can proceed with the repair.</p>
        `,
        []
      );

      console.log(`✅ Job code email sent to provider: ${provider_email}`);
    }

    // ✅ Stripe Connect onboarding (only if provider not connected)
    
const stripeAccountCheck = await pool.query(
  `SELECT provider_stripe_account FROM repair_requests WHERE id = $1`,
  [id]
);

// ✅ Stripe Connect onboarding (stored per repair request)
let stripeAccountId = repair.provider_stripe_account;

if (!stripeAccountId) {
 const account = await stripe.accounts.create({
  type: "express",
  email: provider_email,
  business_type: "individual",

  // ⭐ THIS IS THE FIX → Required for delayed payouts
  capabilities: {
    card_payments: { requested: true },
    transfers: { requested: true }
  }
});

  console.log("✅ Stripe account created:", account.id);


  stripeAccountId = account.id;

  await pool.query(
    `UPDATE repair_requests 
     SET provider_stripe_account = $1 
     WHERE id = $2`,
    [stripeAccountId, id]
  );

      const accountLink = await stripe.accountLinks.create({
        account: stripeAccountId,
        refresh_url: "https://tajernow.com/reauth",
        return_url: "https://tajernow.com/stripe-success",
        type: "account_onboarding",
      });

   const connectSubject = "Action required: Complete your payout setup with Tajer";
const connectHtml = `
  <h3>Hi ${provider_first_name || "there"},</h3>

  <p>You're almost ready to start receiving repair payments on Tajer.</p>

  <p>
    To activate your payout setup securely through Stripe, please click the button below.
  </p>

  <p style="text-align:center;margin:20px 0;">
    <a href="${accountLink.url}"
       style="background:#007bff;color:#fff;padding:12px 20px;
       border-radius:6px;text-decoration:none;display:inline-block;">
       Complete Payout Setup
    </a>
  </p>

  <p>If the button above doesn’t work, copy and paste this link into your browser:</p>
  <p><a href="${accountLink.url}">${accountLink.url}</a></p>

  <p>
    This secure link is powered by Stripe, Tajer’s trusted payment partner.
    Once completed, your account will be ready to receive funds automatically
    whenever a customer pays for a job.
  </p>

  <p>– The Tajer Support Team</p>
`;


      await sendRepairEmail(provider_email, connectHtml);

      console.log(`✅ Stripe Connect email sent to provider: ${provider_email}`);
    }

    res.json({ success: true, repair });
  } catch (err) {
    console.error("❌ Error submitting quote:", err);
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



// ✅ Accept quote and redirect to Stripe
router.get("/payments/start/:id", async (req, res) => {
  try {
    const { id } = req.params;
    console.log("🚀 /payments/start called with ID:", id);

    // 1️⃣ Fetch repair details
    const result = await pool.query(
      `SELECT description, price_quote, requester_email, customer_address, preferred_time 
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

      // ✅ Include all key info for webhook/provider email
      metadata: { 
        repairId: id.toString(), 
        repairType: "repair_request",
        customerAddress: repair.customer_address || "",
        preferredTime: repair.preferred_time || ""
      },
    });

    console.log("💳 Stripe session created:", session.url);

    // 4️⃣ Return Stripe URL to frontend
    res.json({ url: session.url });

  } catch (err) {
    console.error("Error starting repair payment:", err.message);
    res.status(500).send("Failed to start repair payment.");
  }
});


// ✅ Check repair job by job code + email
router.post("/check", async (req, res) => {
  const jobCode = req.body.jobCode?.trim();
const email = req.body.email?.trim().toLowerCase();


  try {
    const result = await pool.query(
  `SELECT id, job_code, description, status, payment_status, completion_status,
          requester_email, provider_email
   FROM repair_requests
   WHERE job_code = $1`,
  [jobCode]
);

    if (result.rows.length === 0)
      return res.status(404).json({ error: "Job not found" });

    const repair = result.rows[0];

    // Determine who is checking (user or provider)
    let role = "";
   if (email === repair.requester_email?.toLowerCase()) role = "user";
else if (email === repair.provider_email?.toLowerCase()) role = "provider";

    else return res.status(403).json({ error: "Unauthorized access" });

    res.json({ success: true, role, repair });
  } catch (err) {
    console.error("❌ Error checking repair:", err);
    res.status(500).json({ error: "Failed to check repair" });
  }
});


// ✅ Provider marks repair as completed (awaiting user confirmation)
router.post("/mark-completed", async (req, res) => {
  try {
    const { jobCode, email } = req.body;

    // Find the job
    const result = await pool.query(
      `SELECT * FROM repair_requests WHERE job_code = $1`,
      [jobCode]
    );

    if (result.rows.length === 0)
      return res.status(404).json({ error: "Job not found" });

    const repair = result.rows[0];

    // Only provider can mark it
    if (email !== repair.provider_email)
      return res.status(403).json({ error: "Unauthorized action" });

    // Update to provider_completed
    await pool.query(
      `UPDATE repair_requests 
       SET completion_status = 'provider_completed'
       WHERE job_code = $1`,
      [jobCode]
    );

    // 📨 Notify requester to confirm completion
    if (repair.requester_email) {
      await sendRepairEmail(
        repair.requester_email,
        `
          <h3>Repair Completed — Confirmation Needed</h3>
          <p>Your provider has marked the job as completed.</p>
          <p><strong>Job Code:</strong> ${repair.job_code}</p>
          <p>Please confirm completion by visiting:</p>
          <a href="${process.env.APP_BASE_URL}/check-my-repair"
             style="background-color:#007bff;color:white;
             padding:10px 16px;border-radius:6px;text-decoration:none;">
             ✅ Confirm Completion
          </a>
        `
      );
    }

    res.json({ success: true, message: "Marked as completed. Waiting for user confirmation." });
  } catch (err) {
    console.error("❌ Error marking job completed:", err);
    res.status(500).json({ error: "Failed to update repair status" });
  }
});

// ✅ User confirms job completion
router.post("/confirm-completion", async (req, res) => {
  const { jobCode, email } = req.body;

  if (!jobCode || !email) {
    return res.status(400).json({ success: false, error: "Missing job code or email" });
  }

  try {
    // 1️⃣ Verify the job
   const { rows } = await pool.query(
  `SELECT * FROM repair_requests WHERE job_code = $1 AND requester_email = $2`,
  [jobCode, email]
);

    if (rows.length === 0)
      return res.status(404).json({ success: false, error: "Repair not found or unauthorized" });

    const repair = rows[0];

    if (repair.completion_status !== "provider_completed") {
      return res.status(400).json({
        success: false,
        error: "Job not yet marked completed by provider",
      });
    }

    // 2️⃣ Update job status
    await pool.query(
      `UPDATE repair_requests 
       SET completion_status = 'user_confirmed', status = 'completed' 
       WHERE job_code = $1`,
      [jobCode]
    );

// 3️⃣ Release payout to provider (90%)
const providerAmount = Math.round(repair.price_quote * 0.90 * 100);

const transfer = await stripe.transfers.create({
  amount: providerAmount,
  currency: "usd",
  destination: repair.provider_stripe_account,
  metadata: {
    repair_id: repair.id,
    job_code: repair.job_code,
    type: "repair_payout"
  }
});

console.log("💰 Payout released to provider:", transfer.id);

    // 4️⃣ Send email notifications
    const subjectProvider = "💰 Payment Released - Job Completed";
    const bodyProvider = `
      Hi ${repair.provider_name || "Provider"},
      <br><br>
      The user has confirmed that the job <strong>${repair.description}</strong> is complete.
      <br>Your payment has been released to your Stripe account.
      <br><br>
      Thank you for providing excellent service!<br>
      <strong>- Repair Platform Team</strong>
    `;

    const subjectUser = "✅ Job Completion Confirmed";
    const bodyUser = `
      Hi ${repair.customer_name || "Customer"},
      <br><br>
      Thank you for confirming the completion of your repair job:
      <strong>${repair.description}</strong>.
      <br>Your payment has been successfully released to the provider.
      <br><br>
      We appreciate your trust in our platform.<br>
      <strong>- Repair Platform Team</strong>
    `;

    await sendRepairEmail(repair.provider_email, subjectProvider, bodyProvider);
   await sendRepairEmail(repair.requester_email, subjectUser, bodyUser);


    res.json({
      success: true,
      message: "✅ Completion confirmed, payment released, and emails sent to both parties.",
    });
  } catch (err) {
    console.error("❌ Error in confirm-completion:", err);
    res.status(500).json({ success: false, error: "Server error confirming completion" });
  }
});
// ✅ Create PaymentIntent (holds funds)
router.post("/create-payment-intent/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // 1️⃣ Fetch repair request
    const result = await pool.query(
      `SELECT * FROM repair_requests WHERE id = $1`,
      [id]
    );
    const repair = result.rows[0];
    if (!repair) return res.status(404).json({ error: "Repair not found" });

    // 2️⃣ Create PaymentIntent (hold payment)
    const paymentIntent = await stripe.paymentIntents.create({
  amount: Math.round(repair.price_quote * 100),
  currency: "usd",

  application_fee_amount: Math.round(repair.price_quote * 0.10 * 100),

  transfer_data: {
    destination: repair.provider_stripe_account,  // ⭐ SEND MONEY TO PROVIDER
  },

  automatic_payment_methods: { enabled: true },

  metadata: {
    repair_id: repair.id,
    provider_account: repair.provider_stripe_account
  }
});


    // 3️⃣ Save PaymentIntent ID
    await pool.query(
      `UPDATE repair_requests SET payment_intent_id = $1 WHERE id = $2`,
      [paymentIntent.id, id]
    );

    res.json({ clientSecret: paymentIntent.client_secret });

  } catch (err) {
    console.error("❌ Error creating PaymentIntent", err);
    res.status(500).json({ error: "Failed to create PaymentIntent" });
  }
});



module.exports = router;
