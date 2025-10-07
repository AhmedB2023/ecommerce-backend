const express = require('express');
const router = express.Router();
const db = require('../db');

// Landlord: set a date RANGE as available/unavailable
// POST /api/properties/:propertyId/availability/range
// body: { from:"2025-10-10", to:"2025-11-10", available:true, note:"optional" }
router.post('/properties/:propertyId/availability/range', async (req, res) => {
  const { propertyId } = req.params;
  let { from, to, available = true, note = null } = req.body;

if (!from) return res.status(400).json({ error: "from date is required" });

// Default to = from + 1 year if not provided
if (!to) {
  const fromDate = new Date(from);
  const oneYearLater = new Date(fromDate);
  oneYearLater.setFullYear(fromDate.getFullYear() + 1);
  to = oneYearLater.toISOString().split("T")[0];
}


  if (!from || !to) return res.status(400).json({ error: "from and to are required (YYYY-MM-DD)" });

  try {
    const q = `
      INSERT INTO property_availability(property_id, day, is_available, note)
      SELECT $1, gs::date, $4, $5
      FROM generate_series($2::date, $3::date, '1 day') AS gs
      ON CONFLICT (property_id, day)
      DO UPDATE SET is_available = EXCLUDED.is_available, note = EXCLUDED.note
      RETURNING property_id, day, is_available, note
    `;
    const { rows } = await db.query(q, [propertyId, from, to, available, note]);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "failed to save availability" });
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
// GET /api/properties/:propertyId/next-available
router.get('/properties/:propertyId/next-available', async (req, res) => {
  const { propertyId } = req.params;

  try {
    const q = `
      WITH dates AS (
        SELECT gs::date AS day
        FROM generate_series(current_date, current_date + interval '60 days', interval '1 day') gs
      ),
      avail AS (
        SELECT d.day, COALESCE(pa.is_available, TRUE) AS is_available
        FROM dates d
        LEFT JOIN property_availability pa
          ON pa.property_id = $1 AND pa.day = d.day
      ),
      reserved AS (
        SELECT generate_series(r.start_date, r.end_date, '1 day')::date AS day
        FROM reservations r
        WHERE r.property_id = $1 AND r.status IN ('pending','accepted','accepted_pending_verification','paid','confirmed')
      )
      SELECT a.day
      FROM avail a
      WHERE a.is_available
        AND NOT EXISTS (SELECT 1 FROM reserved r WHERE r.day = a.day)
      ORDER BY a.day
      LIMIT 1;
    `;

    const result = await db.query(q, [propertyId]);
    const nextAvailable = result.rows[0]?.day;
    res.json({ nextAvailable });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to get next available date" });
  }
});


module.exports = router;
