const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { pool } = require('../config/database');
const fs = require('fs');
const path = require('path');

const router = express.Router();

// Firebase Admin setup
let admin = null;
let firebaseEnabled = false;

try {
  admin = require('firebase-admin');
  
  console.log('🔧 Attempting to initialize Firebase...');

  // Try to load the service account file from the main backend directory
  try {
    const serviceAccountPath = path.join(__dirname, '..', 'service-account-key.json');
    console.log('Looking for Firebase file at:', serviceAccountPath);
    
    if (fs.existsSync(serviceAccountPath)) {
      const serviceAccount = require(serviceAccountPath);
      
      if (!admin.apps.length) {
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount)
        });
        firebaseEnabled = true;
        console.log('✅ Firebase initialized successfully with service-account-key.json');
      }
    } else {
      console.log('❌ service-account-key.json not found at:', serviceAccountPath);
    }
  } catch (fileError) {
    console.log('❌ Error loading Firebase JSON file:', fileError.message);
  }

  if (!firebaseEnabled) {
    console.log('🚫 Firebase not configured. Running in mock mode.');
    admin = null;
  }

} catch (error) {
  console.log('🚫 Firebase Admin SDK not available. Running in mock mode.');
  admin = null;
}

// Get user notifications
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 50, since } = req.query;

    let query = `
      SELECT * FROM notifications 
      WHERE user_id = ? AND is_deleted = FALSE
      ORDER BY received_at DESC 
      LIMIT ?
    `;
    const params = [userId, parseInt(limit)];

    if (since) {
      query = query.replace('WHERE', 'WHERE received_at > ? AND');
      params.unshift(since);
    }

    const [notifications] = await pool.execute(query, params);
    res.json(notifications);
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// Mark notification as read
router.post('/mark-read', authenticateToken, async (req, res) => {
  try {
    const { notificationId } = req.body;
    const userId = req.user.id;

    await pool.execute(
      'UPDATE notifications SET is_read = TRUE WHERE id = ? AND user_id = ?',
      [notificationId, userId]
    );

    res.json({ message: 'Notification marked as read' });
  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({ error: 'Failed to mark notification as read' });
  }
});

// Delete notification
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    await pool.execute(
      'UPDATE notifications SET is_deleted = TRUE WHERE id = ? AND user_id = ?',
      [id, userId]
    );

    res.json({ message: 'Notification deleted' });
  } catch (error) {
    console.error('Error deleting notification:', error);
    res.status(500).json({ error: 'Failed to delete notification' });
  }
});

// Test push notification
router.post('/send-test', authenticateToken, async (req, res) => {
  try {
    const { title, body } = req.body;
    const userId = req.user.id;

    // Rate limiting check
    const [recentTests] = await pool.execute(
      'SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND received_at > DATE_SUB(NOW(), INTERVAL 1 MINUTE)',
      [userId]
    );

    if (recentTests[0].count > 3) {
      return res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
    }

    // Create notification in database
    const [result] = await pool.execute(
      'INSERT INTO notifications (user_id, title, body, sent) VALUES (?, ?, ?, ?)',
      [userId, title || 'Test Notification', body || 'This is a test notification from StreamSync Lite', firebaseEnabled]
    );

    const notificationId = result.insertId;

    if (firebaseEnabled && admin) {
      try {
        // Get user's FCM tokens
        const [tokens] = await pool.execute(
          'SELECT token FROM fcm_tokens WHERE user_id = ?',
          [userId]
        );

        if (tokens.length > 0) {
          const message = {
            notification: {
              title: title || 'Test Notification',
              body: body || 'This is a test notification from StreamSync Lite'
            },
            data: {
              notificationId: notificationId.toString(),
              type: 'test'
            },
            tokens: tokens.map(t => t.token)
          };

          const response = await admin.messaging().sendEachForMulticast(message);
          console.log('✅ Test notification sent successfully via Firebase');
          
          res.json({ 
            message: '✅ Test push notification sent successfully!',
            notificationId 
          });
        } else {
          res.json({ 
            message: '✅ Test notification created but no FCM tokens found for user',
            notificationId 
          });
        }
      } catch (firebaseError) {
        console.error('❌ Firebase send error:', firebaseError);
        res.json({ 
          message: '✅ Test notification created but Firebase send failed',
          notificationId 
        });
      }
    } else {
      // Mock mode - just create in database
      console.log(`🔧 Mock notification created for user ${userId}: ${title}`);
      res.json({ 
        message: '✅ Test notification created successfully! (Firebase not configured)',
        notificationId 
      });
    }

  } catch (error) {
    console.error('Error sending test notification:', error);
    res.status(500).json({ error: 'Failed to send test notification' });
  }
});

module.exports = router;