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
        <p>You received a new quote from ${providerDisplay}.</p>
        <p>The quoted price is <strong>$${price_quote}</strong>.</p>

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

    // ✅ Send provider a confirmation + job code
    if (provider_email) {
      await sendRepairEmail(
        provider_email,
        `
          <h3>Your quote has been submitted successfully!</h3>
          <p>Here is your job code:</p>
          <p><strong>${repair.job_code}</strong></p>
          <p>You'll be notified once the customer makes payment.</p>
        `,
        []
      );

      console.log(`✅ Job code email sent to provider: ${provider_email}`);
    }

    // ❗ NO STRIPE LOGIC HERE ANYMORE

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
     console.log("🔥 ACCEPT ROUTE HIT for", id);

    // Get repair so we have provider email
    const repairResult = await pool.query(
      `SELECT * FROM repair_requests WHERE id = $1`,
      [id]
    );

    if (repairResult.rows.length === 0)
      return res.status(404).send("Repair request not found.");

    const repair = repairResult.rows[0];
    const providerEmail = repair.provider_email;

    // Mark request as accepted
    await pool.query(
      `UPDATE repair_requests
       SET status = 'accepted'
       WHERE id = $1`,
      [id]
    );

    // ------------------------------------------
    // ✅ STRIPE LOGIC
    // ------------------------------------------

    // 1. Try to find ANY existing stripe account for this provider (from any other job)
    const existing = await pool.query(
      `SELECT provider_stripe_account 
       FROM repair_requests 
       WHERE provider_email = $1 
       AND provider_stripe_account IS NOT NULL 
       LIMIT 1`,
      [providerEmail]
    );

    let accountId;

    if (existing.rows.length > 0) {
      // Provider already has Stripe account — reuse it
      accountId = existing.rows[0].provider_stripe_account;
    } else {
      // Create Stripe account ONCE
      const account = await stripe.accounts.create({
        type: "express",
        email: providerEmail,
        business_type: "individual",
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true }
        }
      });

      accountId = account.id;

      // Save Stripe account ID to THIS repair
      await pool.query(
        `UPDATE repair_requests
         SET provider_stripe_account = $1
         WHERE id = $2`,
        [accountId, id]
      );
    }

    // Always generate a NEW onboarding link for that SAME account
    const link = await stripe.accountLinks.create({
      account: accountId,
      type: "account_onboarding",
     refresh_url: "https://ecommerce-backend-y3v4.onrender.com/stripe-refresh",
return_url: "https://ecommerce-backend-y3v4.onrender.com/stripe-return",

    });
    console.log("🔗 Stripe onboarding URL:", link.url);


    // Send onboarding email to provider
    await sendRepairEmail(
      providerEmail,
      `
      <h3>Action Required</h3>
      <p>Please complete your payout setup to receive repair payments.</p>
      <p><a href="${link.url}">Click here to complete setup</a></p>
      `,
      []
    );

    // ------------------------------------------

    res.send(`<h2>✅ Quote Accepted</h2>
              <p>The provider has been notified and will receive a Stripe onboarding link.</p>`);

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



// ✅ Accept quote and charge $20 deposit ONLY
router.post("/payments/start/:id", async (req, res) => {
  try {
    const { id } = req.params;
    console.log("🚀 /payments/start (deposit) called with ID:", id);

    // 1️⃣ Update status to show deposit is needed
    await pool.query(
      `UPDATE repair_requests
       SET status = 'accepted_pending_deposit'
       WHERE id = $1`,
      [id]
    );

    // 2️⃣ Create Stripe customer (⭐ REQUIRED)
    const customer = await stripe.customers.create({});

    // 3️⃣ Create $20 deposit PaymentIntent (CHARGE NOW)
    const paymentIntent = await stripe.paymentIntents.create({
      amount: 2000,               // $20
      currency: "usd",
      customer: customer.id,      // ⭐ attach customer
      payment_method_types: ["card"],

      // ⭐ REQUIRED FOR SAVING PAYMENT METHOD IN 2025 API VERSION
      setup_future_usage: "off_session",
      payment_method_options: {
        card: {
          setup_future_usage: "off_session"
        }
      },

      metadata: {
        repairId: id.toString(),
        type: "deposit"
      }
    });

    console.log("💳 Deposit PaymentIntent created:", paymentIntent.id);

    // 4️⃣ Save customer (payment method saved later)
    await pool.query(
      `UPDATE repair_requests
       SET customer_id = $1
       WHERE id = $2`,
      [customer.id, id]
    );

    // 5️⃣ Send clientSecret back to frontend
    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      customerId: customer.id    // ⭐ ADD THIS
    });

  } catch (err) {
    console.error("❌ Deposit creation error:", err.message);
    res.status(500).json({ error: "Failed to start deposit payment." });
  }
});


// ✅ Check repair job by job code + email
router.post("/check", async (req, res) => {
  const jobCode = req.body.jobCode?.trim();
const email = req.body.email?.trim().toLowerCase();


  try {
    const result = await pool.query(
  `SELECT id, job_code, description, status, payment_status, completion_status,
          requester_email, provider_email, price_quote
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
    const { jobCode, email, final_price } = req.body;


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
     SET completion_status = 'provider_completed',
         final_price = $1
     WHERE job_code = $2`,
  [req.body.final_price, jobCode]
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

  try {
    // 1️⃣ Verify job
    const { rows } = await pool.query(
      `SELECT * FROM repair_requests 
       WHERE job_code = $1 AND requester_email = $2`,
      [jobCode, email]
    );

    if (rows.length === 0)
      return res.status(404).json({ success: false, error: "Not found" });

    const repair = rows[0];
    const hasStripe = !!repair.provider_stripe_account;

    if (!repair.payment_method_id) {
      return res.status(400).json({
        success: false,
        error: "Missing saved payment method — user never completed deposit"
      });
    }

    // 2️⃣ Calculate remaining charge
    console.log("🔥 final_price =", repair.final_price);

    const remaining = Number(repair.final_price) - 20;

    const chargeAmount = Math.round(remaining * 100);

    if (remaining <= 0) {
  return res.status(400).json({
    success: false,
    error: "Final price must be greater than the $20 deposit"
  });
}

    // 3️⃣ Base PaymentIntent structure
    let paymentIntentData = {
      amount: chargeAmount,
      currency: "usd",
      customer: repair.customer_id,        // may be deleted below
      payment_method: repair.payment_method_id,
      off_session: true,
      confirm: true
    };

    // 🛑 Remove empty customer_id (prevents Stripe error)
    if (!repair.customer_id) {
      delete paymentIntentData.customer;
    }

    // 4️⃣ Check Stripe capabilities (only if provider has account)
    let transfersActive = false;

    if (hasStripe) {
      const acct = await stripe.accounts.retrieve(repair.provider_stripe_account);
      transfersActive = acct.capabilities?.transfers === "active";
    }

 // 10% platform fee ALWAYS
paymentIntentData.application_fee_amount =
  Math.round(Number(repair.final_price) * 0.10 * 100);

// Only set transfer destination if it's a NON-EMPTY valid Stripe account ID
if (repair.provider_stripe_account && repair.provider_stripe_account.trim() !== "") {
  paymentIntentData.transfer_data = {
    destination: repair.provider_stripe_account
  };
}



    // 6️⃣ Create PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create(paymentIntentData);

    // 7️⃣ Update db
    await pool.query(
      `UPDATE repair_requests
       SET completion_status = 'user_confirmed',
           payment_status = 'final_paid',
           status = 'completed'
       WHERE job_code = $1`,
      [jobCode]
    );

    res.json({
      success: true,
      message: "Final payment charged. Payout will be released after provider onboarding."
    });

  } catch (err) {
    console.error("❌ Error in confirm-completion:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});





// Admin triggers payout after provider creates account
router.post("/release-payment", async (req, res) => {
  const { repairId } = req.body;

  try {
    // 1️⃣ Fetch repair
    const { rows } = await pool.query(
      `SELECT * FROM repair_requests WHERE id = $1`,
      [repairId]
    );
    const repair = rows[0];

    if (!repair)
      return res.json({ success: false, message: "Repair not found" });

    // 2️⃣ Provider MUST have a Stripe account
    if (!repair.provider_stripe_account) {
      return res.json({
        success: false,
        message: "Provider still does not have a Stripe account."
      });
    }

    // 3️⃣ Check Stripe Connect account capability
    const account = await stripe.accounts.retrieve(
      repair.provider_stripe_account
    );

    // ⭐ EXPRESS accounts only require transfers to be active
    if (account.capabilities?.transfers !== "active") {
      return res.json({
        success: false,
        message: "Provider has not finished onboarding yet."
      });
    }

    // 4️⃣ Block payout until user confirms completion
    if (repair.completion_status !== "user_confirmed") {
      return res.json({
        success: false,
        message: "User has not confirmed completion yet."
      });
    }

    // 5️⃣ Prevent duplicate payout
    if (repair.payout_released_at) {
      return res.json({ success: false, message: "Already paid once." });
    }

    // 6️⃣ Calculate payout
    const final = Number(repair.final_price || repair.price_quote);
    const providerAmount = Math.round(final * 0.90 * 100);

    // 7️⃣ Release payout to provider
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

    // 8️⃣ Mark payout released
    await pool.query(
      `UPDATE repair_requests
       SET payout_released_at = NOW()
       WHERE id = $1`,
      [repair.id]
    );

    res.json({
      success: true,
      message: "Payout released to provider.",
      transferId: transfer.id
    });

  } catch (err) {
    console.error("❌ Error in release-payment:", err);
    res.json({ success: false, message: "Server error" });
  }
});



// ✅ Provider updates final price AFTER inspection
router.post("/update-final-price", async (req, res) => {
  try {
    const { repairId, provider_email, final_price, materials_cost, reason } = req.body;

    // 1️⃣ Validate input
    if (!repairId || !provider_email || !final_price) {
      return res.status(400).json({ success: false, error: "Missing fields" });
    }

    // 2️⃣ Ensure provider owns this job
    const { rows } = await pool.query(
      `SELECT * FROM repair_requests WHERE id = $1 AND provider_email = $2`,
      [repairId, provider_email]
    );

    if (rows.length === 0) {
      return res.status(403).json({ success: false, error: "Unauthorized" });
    }

    const repair = rows[0];

    // 3️⃣ Update repair with new final price + materials
    await pool.query(
      `UPDATE repair_requests 
       SET final_price = $1,
           materials_cost = $2,
           status = 'final_price_pending_user'
       WHERE id = $3`,
      [final_price, materials_cost || 0, repairId]
    );

    // 4️⃣ Notify the user
    const requesterEmail = repair.requester_email;
    if (requesterEmail) {
      await sendRepairEmail(
        requesterEmail,
        `
          <h3>Updated Quote for Your Repair</h3>

          <p>The provider has updated the final price after inspection.</p>

          <p><strong>Initial price:</strong> $${repair.price_quote}</p>
          <p><strong>New final price:</strong> $${final_price}</p>
          <p><strong>Materials cost:</strong> $${materials_cost || 0}</p>
          <p><strong>Reason:</strong> ${reason || "Not provided"}</p>

          <a href="${process.env.APP_BASE_URL}/accept-updated-price?repairId=${repairId}"
             style="background:#28a745;color:white;padding:10px 16px;border-radius:6px;text-decoration:none;">
             ✅ Accept Updated Price
          </a>

          <a href="${process.env.APP_BASE_URL}/reject-updated-price?repairId=${repairId}"
             style="background:#dc3545;color:white;padding:10px 16px;border-radius:6px;text-decoration:none;margin-left:10px;">
             ❌ Reject Updated Price
          </a>
        `
      );
    }

    res.json({ success: true, message: "Final price updated and user notified." });

  } catch (err) {
    console.error("❌ Error updating final price:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});


// ⭐ Save payment method after deposit succeeds
router.post("/save-payment-method", async (req, res) => {
  const { repairId, customerId, paymentMethodId } = req.body;

  await pool.query(
    `UPDATE repair_requests
     SET customer_id = $1,
         payment_method_id = $2
     WHERE id = $3`,
    [customerId, paymentMethodId, repairId]
  );

  res.json({ success: true });
});



   



module.exports = router;
