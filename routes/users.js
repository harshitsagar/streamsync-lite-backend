const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { pool } = require('../config/database');

const router = express.Router();

// Register FCM token
router.post('/:id/fcmToken', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { token, platform } = req.body;

    await pool.execute(
      `INSERT INTO fcm_tokens (user_id, token, platform) 
       VALUES (?, ?, ?) 
       ON DUPLICATE KEY UPDATE 
       platform=VALUES(platform), created_at=CURRENT_TIMESTAMP`,
      [userId, token, platform || 'unknown']
    );

    res.json({ message: 'FCM token registered' });
  } catch (error) {
    console.error('Error registering FCM token:', error);
    res.status(500).json({ error: 'Failed to register FCM token' });
  }
});

// Remove FCM token
router.delete('/:id/fcmToken', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { token } = req.body;

    await pool.execute(
      'DELETE FROM fcm_tokens WHERE user_id = ? AND token = ?',
      [userId, token]
    );

    res.json({ message: 'FCM token removed' });
  } catch (error) {
    console.error('Error removing FCM token:', error);
    res.status(500).json({ error: 'Failed to remove FCM token' });
  }
});

module.exports = router;