const express = require("express");
const router = express.Router();
const pool = require("../db");

// ✅ Create repair request
router.post("/", async (req, res) => {
  try {
    const { property_id, requester_id, description, image_urls } = req.body;
    if (!description) return res.status(400).json({ error: "Description is required" });

    const result = await pool.query(
      `INSERT INTO repair_requests (property_id, requester_id, description, image_urls)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [property_id || null, requester_id || null, description, image_urls || []]
    );
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
    const { provider_id, price_quote } = req.body;
    if (!provider_id || !price_quote)
      return res.status(400).json({ error: "provider_id and price_quote are required" });

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

    res.json({ success: true, repair: result.rows[0] });
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

module.exports = router;
