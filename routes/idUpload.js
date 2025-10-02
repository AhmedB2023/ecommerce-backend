const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db'); // ✅ DB import moved up

const router = express.Router();
console.log("🚀 idUpload.js loaded on server");  // ✅ put it here

// ✅ Parse JSON body for POST requests like /verify-id
router.use(express.json());

// Make sure /uploads/ids exists
const ID_DIR = path.join(__dirname, '..', 'uploads', 'ids');
fs.mkdirSync(ID_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ID_DIR),
  filename: (req, file, cb) => {
    const reservationId = (req.body?.reservationId || 'unknown').toString();
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${reservationId}_${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 6 * 1024 * 1024 }, // 6 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});

// Expect fields: frontId (required), backId, selfie
const idUpload = upload.fields([
  { name: 'frontId', maxCount: 1 },
  { name: 'backId', maxCount: 1 },
  { name: 'selfie', maxCount: 1 },
]);

// ✅ Upload ID route (file upload)
router.post('/upload-id', idUpload, async (req, res) => {
  const { reservationId } = req.body || {}; 

  if (!reservationId || !req.files?.frontId) {
    return res.status(400).json({ error: 'Missing reservationId or frontId' });
  }

  const frontFilename = req.files.frontId[0].filename;
  const backFilename = req.files.backId?.[0]?.filename || null;
  const selfieFilename = req.files.selfie?.[0]?.filename || null;

  try {
    await db.query(
      'UPDATE reservations SET id_front_url = $1 WHERE id = $2',
      [frontFilename, reservationId]
    );

    return res.json({
      ok: true,
      reservationId,
      frontId: frontFilename,
      backId: backFilename,
      selfie: selfieFilename,
    });
  } catch (err) {
    console.error('❌ Error saving ID URL to DB:', err);
    return res.status(500).json({ error: 'Failed to update reservation with ID URL' });
  }
});

// ✅ Verify ID route (plain JSON)
router.post('/verify-id', async (req, res) => {
  console.log('✅ /verify-id hit with body:', req.body);

  const { reservationId } = req.body || {};

  if (!reservationId) {
    return res.status(400).json({ error: 'Missing reservationId' });
  }

  try {
    const result = await db.query(
      'UPDATE reservations SET id_verified = true WHERE id = $1 RETURNING *',
      [reservationId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Reservation not found' });
    }

    res.json({ ok: true, updated: result.rows[0] });
  } catch (err) {
    console.error('❌ Error verifying ID:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ✅ Fetch unverified IDs
router.get('/unverified-ids', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, guest_name, guest_contact, id_front_url 
       FROM reservations 
       WHERE id_front_url IS NOT NULL AND id_verified = false 
       ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error fetching unverified IDs:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
