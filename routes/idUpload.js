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

router.post('/upload-id', idUpload, (req, res) => {
  const { reservationId } = req.body;
  if (!reservationId || !req.files.frontId) {
    return res.status(400).json({ error: 'Missing reservationId or frontId' });
  }

  return res.json({
    ok: true,
    reservationId,
    frontId: req.files.frontId[0].filename,
    backId: req.files.backId?.[0]?.filename || null,
    selfie: req.files.selfie?.[0]?.filename || null,
  });
});

module.exports = router;
