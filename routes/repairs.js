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

    // Get repair
    const repairResult = await pool.query(
      `SELECT * FROM repair_requests WHERE id = $1`,
      [id]
    );

    if (repairResult.rows.length === 0)
      return res.status(404).send("Repair request not found.");

    // Mark as accepted ONLY
    await pool.query(
      `UPDATE repair_requests
       SET status = 'accepted'
       WHERE id = $1`,
      [id]
    );

    // ❌ NO STRIPE LOGIC HERE
    // ❌ NO STRIPE ACCOUNT CREATED
    // ❌ NO ONBOARDING LINK
    // ❌ NO EMAIL TO PROVIDER HERE

    // User will now go pay the deposit
    res.send(`
      <h2>✅ Quote Accepted</h2>
      <p>Please proceed to the payment page to pay the $20 deposit.</p>
    `);

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

    // 1️⃣ Load repair + provider
    const { rows } = await pool.query(
      `SELECT provider_email, provider_stripe_account
       FROM repair_requests
       WHERE id = $1`,
      [id]
    );

    if (rows.length === 0)
      return res.status(404).json({ error: "Repair not found" });

    const repair = rows[0];
    let providerStripeAccount = repair.provider_stripe_account;

    // 2️⃣ Reuse existing Stripe account if provider already has one
    if (!providerStripeAccount) {
      const existing = await pool.query(
        `SELECT provider_stripe_account
         FROM repair_requests
         WHERE provider_email = $1
           AND provider_stripe_account IS NOT NULL
         LIMIT 1`,
        [repair.provider_email]
      );

      if (existing.rows.length > 0) {
        providerStripeAccount = existing.rows[0].provider_stripe_account;

        await pool.query(
          `UPDATE repair_requests
           SET provider_stripe_account = $1
           WHERE id = $2`,
          [providerStripeAccount, id]
        );
      }
    }

    // 3️⃣ Create Stripe account ONLY if none exists
    if (!providerStripeAccount) {
      const account = await stripe.accounts.create({
        type: "express",
        email: repair.provider_email,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true }
        }
      });

      providerStripeAccount = account.id;

      await pool.query(
        `UPDATE repair_requests
         SET provider_stripe_account = $1
         WHERE id = $2`,
        [providerStripeAccount, id]
      );

      // send onboarding link
      await sendRepairEmail(
        repair.provider_email,
        `Complete Stripe onboarding:
         ${process.env.APP_BASE_URL}/api/repairs/provider/start-onboarding?email=${repair.provider_email}`
      );
    }

    // 4️⃣ Update repair status
    await pool.query(
      `UPDATE repair_requests
       SET status = 'accepted_pending_deposit'
       WHERE id = $1`,
      [id]
    );

    // 5️⃣ Create Stripe customer
    const customer = await stripe.customers.create({});

    // 6️⃣ Create $20 deposit PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: 2000,
      currency: "usd",
      customer: customer.id,
      payment_method_types: ["card"],
      setup_future_usage: "off_session",
      payment_method_options: {
        card: { setup_future_usage: "off_session" }
      },
      metadata: { repairId: id, type: "deposit" }
    });

    // 7️⃣ Save payment info
    await pool.query(
      `UPDATE repair_requests
       SET customer_id = $1,
           payment_intent_id = $2
           payment_method_id = $3
       WHERE id = $4`,
      [customer.id, paymentIntent.id,paymentIntent.payment_method, id]
    );

    // 8️⃣ Return client secret
    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      customerId: customer.id
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to start deposit payment" });
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
      return res.status(404).json({ error: "Not found" });

    const repair = rows[0];
    console.log("🔍 payment_method_id from DB:", repair.payment_method_id);

    if (repair.completion_status === "user_confirmed") {
      return res.status(400).json({ error: "Already completed" });
    }

    if (!repair.payment_method_id) {
      return res.status(400).json({ error: "Missing saved card" });
    }

    // 2️⃣ Calculate remaining charge
    const remaining = Number(repair.final_price) - 20;
    if (remaining <= 0) {
      return res.status(400).json({ error: "Invalid final price" });
    }

    const chargeAmount = Math.round(remaining * 100);

    // 3️⃣ Charge customer (ALWAYS)
    const paymentIntent = await stripe.paymentIntents.create({
      amount: chargeAmount,
      currency: "usd",
      payment_method: repair.payment_method_id,
      customer: repair.customer_id || undefined,
      off_session: true,
      confirm: true,
    });

    // 4️⃣ Mark job completed + save PaymentIntent
    await pool.query(
      `UPDATE repair_requests
       SET completion_status = 'user_confirmed',
           payment_status = 'final_paid',
           status = 'completed',
           payment_intent_id = $2
       WHERE job_code = $1`,
      [jobCode, paymentIntent.id]
    );

    // 5️⃣ Check if provider is onboarded
    let transfersActive = false;
    if (repair.provider_stripe_account) {
      const acct = await stripe.accounts.retrieve(
        repair.provider_stripe_account
      );
      transfersActive = acct.capabilities?.transfers === "active";
    }

    // 6️⃣ INSTANT payout if onboarded
    if (transfersActive) {
      const providerAmount = Math.round(
        Number(repair.final_price) * 0.9 * 100
      );

      await stripe.transfers.create({
        amount: providerAmount,
        currency: "usd",
        destination: repair.provider_stripe_account,
        source_transaction: repair.charge_id,
        metadata: {
          repair_id: repair.id,
          job_code: repair.job_code,
          type: "instant_payout",
        },
      });

      await pool.query(
        `UPDATE repair_requests
         SET payout_released_at = NOW()
         WHERE job_code = $1`,
        [jobCode]
      );
    }

    // 7️⃣ Done
    res.json({
      success: true,
      message: transfersActive
        ? "Payment charged and provider paid instantly."
        : "Payment charged. Provider will be paid after onboarding.",
    });

  } catch (err) {
    console.error("❌ confirm-completion error:", err);
    res.status(500).json({ error: "Server error" });
  }
});






// Admin triggers payout after provider completes onboarding
router.post("/release-payment", async (req, res) => {

  const { repairId } = req.body;

  try {
    console.log("🔥 RELEASE PAYMENT HIT for repair:", repairId);

    // 1️⃣ Fetch repair
    const { rows } = await pool.query(
      `SELECT * FROM repair_requests WHERE id = $1`,
      [repairId]
    );

    const repair = rows[0];
    if (!repair) {
      console.log("❌ Repair not found");
      return res.json({ success: false, message: "Repair not found" });
    }

    // 2️⃣ Must have Stripe account
    if (!repair.provider_stripe_account) {
      console.log("❌ Provider missing Stripe account");
      return res.json({
        success: false,
        message: "Provider still does not have a Stripe account."
      });
    }

    // 3️⃣ Check onboarding status
    const account = await stripe.accounts.retrieve(
      repair.provider_stripe_account
    );

    if (account.capabilities?.transfers !== "active") {
      console.log("❌ Provider not onboarded:", account.capabilities);
      return res.json({
        success: false,
        message: "Provider has not finished onboarding yet."
      });
    }

    // 4️⃣ User must confirm completion
    if (repair.completion_status !== "user_confirmed") {
      console.log("❌ User not confirmed yet");
      return res.json({
        success: false,
        message: "User has not confirmed completion yet."
      });
    }

    // 5️⃣ Prevent double payout
    if (repair.payout_released_at) {
      console.log("⚠️ Already paid previously");
      return res.json({
        success: false,
        message: "Already paid once."
      });
    }

    // 6️⃣ Compute payout
    const finalPrice = Number(repair.final_price || repair.price_quote);
    const providerAmount = Math.round(finalPrice * 0.90 * 100);

    console.log(`💵 Sending payout: $${providerAmount / 100}`);

    // 7️⃣ Send transfer
    const transfer = await stripe.transfers.create({
      amount: providerAmount,
      currency: "usd",
      destination: repair.provider_stripe_account,
      metadata: {
        repair_id: repair.id,
        job_code: repair.job_code,
        type: "repair_payout",
      },
    });

    console.log("✅ Transfer success:", transfer.id);

    // 8️⃣ Update DB
    await pool.query(
      `UPDATE repair_requests
       SET payout_released_at = NOW()
       WHERE id = $1`,
      [repair.id]
    );

    console.log("🏁 RELEASE PAYMENT FINISHED");

    return res.json({
      success: true,
      message: "Payout released to provider.",
      transferId: transfer.id,
    });

  } catch (err) {
    console.error("❌ Error in release-payment:", err);
    return res.json({ success: false, message: "Server error" });
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



router.get("/provider/start-onboarding", async (req, res) => {
  const providerEmail = req.query.email;
  if (!providerEmail) return res.status(400).send("Missing provider email");

  let accountId; // ✅ DECLARE FIRST

  try {
    const existing = await pool.query(
      `SELECT provider_stripe_account
       FROM repair_requests
       WHERE provider_email = $1
         AND provider_stripe_account IS NOT NULL
       LIMIT 1`,
      [providerEmail]
    );

    if (existing.rows.length > 0) {
      accountId = existing.rows[0].provider_stripe_account;
    } else {
      const account = await stripe.accounts.create({
        type: "express",
        email: providerEmail,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true }
        }
      });

      accountId = account.id;

      await pool.query(
        `UPDATE repair_requests
         SET provider_stripe_account = $1
         WHERE provider_email = $2`,
        [accountId, providerEmail]
      );
    }

    const link = await stripe.accountLinks.create({
      account: accountId,
      type: "account_onboarding",
      refresh_url: `${process.env.APP_BASE_URL}/api/repairs/provider/start-onboarding?email=${providerEmail}`,
      return_url: `${process.env.APP_BASE_URL}/api/repairs/onboarding-complete?account=${accountId}`

    });

    return res.redirect(link.url);

  } catch (err) {
    console.error("ONBOARDING ERROR:", err.message);
    return res.status(500).send(err.message);
  }
});

router.get("/onboarding-complete", async (req, res) => {
  const { account } = req.query;

  // find waiting repairs
  const result = await pool.query(
    `SELECT id FROM repair_requests
     WHERE provider_stripe_account = $1
     AND completion_status = 'user_confirmed'
     AND payout_released_at IS NULL`,
    [account]
  );

  for (const row of result.rows) {
    await axios.post(
      `${process.env.APP_BASE_URL}/api/repairs/release-payment`,
      { repairId: row.id }
    );
  }

  res.redirect("https://tajernow.com/onboarding-success");
});


   



module.exports = router;
