// Load environment variables
require('dotenv').config();
const { initDB } = require('./config/database');

async function initializeDatabase() {
  console.log('🔧 Initializing database tables...');
  try {
    await initDB();
    console.log('✅ Database tables initialized successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Failed to initialize database:', error);
    process.exit(1);
  }
}

initializeDatabase();