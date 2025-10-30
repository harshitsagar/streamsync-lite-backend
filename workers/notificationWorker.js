const { pool } = require('../config/database');
const fs = require('fs');
const path = require('path');

// Firebase Admin setup
let admin = null;
let firebaseEnabled = false;

try {
  admin = require('firebase-admin');
  
  // Try to load the service account file from the main backend directory
  try {
    const serviceAccountPath = path.join(__dirname, '..', 'service-account-key.json');
    
    if (fs.existsSync(serviceAccountPath)) {
      const serviceAccount = require(serviceAccountPath);
      
      if (!admin.apps.length) {
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount)
        });
        firebaseEnabled = true;
        console.log('✅ Firebase worker initialized successfully');
      }
    }
  } catch (fileError) {
    console.log('❌ Firebase worker: Could not load service account file');
  }

  if (!firebaseEnabled) {
    console.log('🚫 Notification worker running in mock mode (Firebase disabled)');
    admin = null;
  }

} catch (error) {
  console.log('🚫 Firebase Admin SDK not available for worker. Running in mock mode.');
  admin = null;
}

class NotificationWorker {
  constructor() {
    this.isRunning = false;
    this.maxRetries = 5;
    this.dbConnected = false;
  }

  async start() {
    this.isRunning = true;
    
    // Test database connection first
    await this.testDatabaseConnection();
    
    if (firebaseEnabled && this.dbConnected) {
      console.log('✅ Notification worker started with Firebase support');
    } else if (this.dbConnected) {
      console.log('🔧 Notification worker started in mock mode (DB connected)');
    } else {
      console.log('🚫 Notification worker started in offline mode (DB not connected)');
    }
    
    while (this.isRunning) {
      try {
        if (this.dbConnected) {
          await this.processJobs();
        }
        await this.sleep(firebaseEnabled ? 10000 : 30000); // Check every 10-30 seconds
      } catch (error) {
        console.error('Worker error:', error.message);
        await this.sleep(30000);
      }
    }
  }

  async testDatabaseConnection() {
    try {
      const connection = await pool.getConnection();
      console.log('✅ Worker: Database connection successful');
      connection.release();
      this.dbConnected = true;
    } catch (error) {
      console.log('❌ Worker: Database connection failed:', error.message);
      this.dbConnected = false;
    }
  }

  async processJobs() {
    if (!firebaseEnabled || !this.dbConnected) {
      return;
    }

    const connection = await pool.getConnection();
    
    try {
      await connection.beginTransaction();

      // Get pending job
      const [jobs] = await connection.execute(
        `SELECT nj.*, n.*, u.id as user_id 
         FROM notification_jobs nj
         JOIN notifications n ON nj.notification_id = n.id
         JOIN users u ON n.user_id = u.id
         WHERE nj.status = 'pending' 
         ORDER BY nj.created_at ASC 
         LIMIT 1 FOR UPDATE SKIP LOCKED`
      );

      if (jobs.length === 0) {
        await connection.rollback();
        return;
      }

      const job = jobs[0];

      // Mark as processing
      await connection.execute(
        'UPDATE notification_jobs SET status = "processing", processing_at = NOW() WHERE id = ?',
        [job.id]
      );

      await connection.commit();

      // Process the job with Firebase
      await this.sendNotification(job, connection);

    } catch (error) {
      await connection.rollback();
      console.error('Job processing error:', error.message);
    } finally {
      connection.release();
    }
  }

  async sendNotification(job, connection) {
    try {
      // Get user's FCM tokens
      const [tokens] = await connection.execute(
        'SELECT token FROM fcm_tokens WHERE user_id = ?',
        [job.user_id]
      );

      if (tokens.length === 0) {
        await this.markJobFailed(connection, job.id, 'No FCM tokens found for user');
        return;
      }

      const message = {
        notification: {
          title: job.title,
          body: job.body
        },
        data: {
          notificationId: job.notification_id,
          type: 'general'
        },
        tokens: tokens.map(t => t.token)
      };

      const response = await admin.messaging().sendEachForMulticast(message);

      // Update job status
      if (response.failureCount > 0) {
        const errors = response.responses
          .map((resp, idx) => resp.error ? `Token ${tokens[idx].token}: ${resp.error.message}` : null)
          .filter(Boolean);
        
        await this.retryOrFail(connection, job.id, errors.join('; '));
      } else {
        await connection.execute(
          'UPDATE notification_jobs SET status = "sent" WHERE id = ?',
          [job.id]
        );
        await connection.execute(
          'UPDATE notifications SET sent = TRUE WHERE id = ?',
          [job.notification_id]
        );
        console.log(`✅ Notification ${job.id} sent successfully`);
      }

    } catch (error) {
      console.error('Error sending notification:', error.message);
      await this.retryOrFail(connection, job.id, error.message);
    }
  }

  async retryOrFail(connection, jobId, error) {
    const [job] = await connection.execute(
      'SELECT retries FROM notification_jobs WHERE id = ?',
      [jobId]
    );

    const currentRetries = job[0].retries;

    if (currentRetries >= this.maxRetries) {
      await connection.execute(
        'UPDATE notification_jobs SET status = "failed", last_error = ? WHERE id = ?',
        [`Max retries exceeded: ${error}`, jobId]
      );
    } else {
      await connection.execute(
        'UPDATE notification_jobs SET status = "pending", retries = retries + 1, last_error = ? WHERE id = ?',
        [error, jobId]
      );
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  stop() {
    this.isRunning = false;
    console.log('Notification worker stopped');
  }
}

// Start worker if this file is run directly
if (require.main === module) {
  const worker = new NotificationWorker();
  worker.start();

  process.on('SIGINT', () => {
    worker.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    worker.stop();
    process.exit(0);
  });
}

module.exports = NotificationWorker;