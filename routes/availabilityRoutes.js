const express = require('express');
const router = express.Router();
const db = require('../db');

// Landlord: set a date RANGE as available/unavailable
// POST /api/properties/:propertyId/availability/range
// body: { from:"2025-10-10", to:"2025-11-10", available:true, note:"optional" }
router.post('/properties/:propertyId/availability/range', async (req, res) => {
  const { propertyId } = req.params;
  let { from, to, available = true } = req.body;

  if (!from) {
    return res.status(400).json({ error: "Start date (from) is required" });
  }

  // Allow open-ended range
  if (!to || to === "") {
    to = null;
  }

  try {
    await db.query(`
  INSERT INTO availability (property_id, start_date, end_date, is_available, created_at)
  VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
  ON CONFLICT (property_id)
  DO UPDATE SET 
    start_date = EXCLUDED.start_date,
    end_date = EXCLUDED.end_date,
    is_available = EXCLUDED.is_available
`, [propertyId, from?.split("T")[0], to?.split("T")[0], available]);


    res.json({ message: "Availability updated" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to update availability" });
  }
});

// Anyone: get availability merged with reservations
// GET /api/properties/:propertyId/availability?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/properties/:propertyId/availability', async (req, res) => {
  const { propertyId } = req.params;
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: "from and to are required" });

  try {
    // statuses that should BLOCK dates (tweak as needed)
    const blockingStatuses = ['pending','accepted','accepted_pending_verification','paid','confirmed'];

    const q = `
      WITH days AS (
        SELECT gs::date AS day
        FROM generate_series($2::date, $3::date, '1 day') gs
      ),
      avail AS (
        SELECT d.day, COALESCE(pa.is_available, TRUE) AS is_available
        FROM days d
        LEFT JOIN property_availability pa
          ON pa.property_id = $1 AND pa.day = d.day
      ),
      reserved AS (
        SELECT generate_series(r.start_date, r.end_date, '1 day')::date AS day
        FROM reservations r
        WHERE r.property_id = $1 AND r.status = ANY($4)
      )
      SELECT a.day,
             (a.is_available AND NOT EXISTS (SELECT 1 FROM reserved rs WHERE rs.day = a.day)) AS is_free
      FROM avail a
      ORDER BY a.day;
    `;
    const { rows } = await db.query(q, [propertyId, from, to, blockingStatuses]);
    res.json(rows); // [{day: '2025-10-10', is_free: true}, ...]
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "failed to fetch availability" });
  }
});


module.exports = router;
