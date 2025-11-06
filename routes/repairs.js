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

    // 1️⃣ Get provider_id from email
    const providerRes = await pool.query(
      `SELECT id FROM users WHERE email = $1`,
      [provider_email]
    );
    const provider_id = providerRes.rows[0]?.id;
    if (!provider_id)
      return res.status(400).json({ error: "Provider not found" });

    // 2️⃣ Update repair request
    const result = await pool.query(
      `UPDATE repair_requests
       SET selected_provider_id = $1,
           price_quote = $2,
           status = 'quoted'
       WHERE id = $3
       RETURNING *`,
      [provider_id, price_quote, id]
    );

    if (result.rows.length === 0)
      return res.status(404).json({ error: "Repair request not found" });

    const repair = result.rows[0];

    // 3️⃣ Notify requester with provider info (no email)
    const requesterEmail = repair.requester_email;
    if (requesterEmail) {
      const sendRepairEmail = require("../utils/sendRepairEmail");
      const providerDisplay = `${provider_first_name} ${provider_last_name} from ${provider_city}`;

      await sendRepairEmail(
        requesterEmail,
        `Good news! ${providerDisplay} has submitted a quote of $${price_quote} for your repair request.`,
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
router.put("/:id/accept", async (req, res) => {
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
      return res.status(404).json({ error: "Repair request not found" });

    res.json({ success: true, repair: result.rows[0] });
  } catch (err) {
    console.error("Error accepting quote:", err);
    res.status(500).json({ error: "Failed to accept quote" });
  }
});
router.put("/:id/quote", async (req, res) => {
  const { id } = req.params;
  const { provider_email, price_quote } = req.body;

  try {
    const result = await pool.query(
      `UPDATE repair_requests
       SET provider_email = $1, price_quote = $2, status = 'quoted'
       WHERE id = $3
       RETURNING *`,
      [provider_email, price_quote, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Repair not found" });
    }
 const repair = result.rows[0];

    // ✅ Step 1 — Send Brevo email to requester (without provider email)
    if (repair.requester_email) {
      try {
        await sendBrevoEmail({
          to: repair.requester_email,
          subject: "You received a new quote for your repair request!",
          htmlContent: `
            <h3>Hello!</h3>
            <p>A service provider has submitted a quote for your request.</p>
            <p>Quoted price: <b>$${price_quote}</b></p>
            <p>Please visit 
              <a href="https://tajernow.com/repair-status/${id}" 
                 style="background:#007bff;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;">
                 Review and Respond
              </a>
            </p>
            <p>Thank you for using Tajer!</p>
          `
        });
        console.log("📧 Email sent to requester:", repair.requester_email);
      } catch (emailErr) {
        console.error("Error sending Brevo email:", emailErr);
      }
    }

    res.json({ success: true, repair: result.rows[0] });
  } catch (err) {
    console.error("Error updating repair quote:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});


module.exports = router;
