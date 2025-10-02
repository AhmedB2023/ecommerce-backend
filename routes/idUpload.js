const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const router = express.Router();

// Make sure /uploads/ids exists
const ID_DIR = path.join(__dirname, '..', 'uploads', 'ids');
fs.mkdirSync(ID_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ID_DIR),
  filename: (req, file, cb) => {
    const reservationId = (req.body.reservationId || 'unknown').toString();
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

router.post('/upload-id', idUpload, async (req, res) => {
  const { reservationId } = req.body;

  if (!reservationId || !req.files.frontId) {
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


const db = require('../db'); // add this at the top if not already

router.post('/verify-id', async (req, res) => {
  const { reservationId } = req.body;

  if (!reservationId) {
    return res.status(400).json({ error: 'Missing reservationId' });
  }

  try {
    const result = await db.query(
      'UPDATE reservations SET id_verified = true WHERE id = $1 RETURNING *',
      [reservationId]
    );
    res.json({ ok: true, updated: result.rows[0] });
  } catch (err) {
    console.error('❌ Error verifying ID:', err);
    res.status(500).json({ error: 'Server error' });
  }
});
router.get('/unverified-ids', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, guest_name, guest_contact, id_front_url FROM reservations WHERE id_front_url IS NOT NULL AND id_verified = false ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error fetching unverified IDs:', err);
    res.status(500).json({ error: 'Server error' });
  }
});


module.exports = router;
