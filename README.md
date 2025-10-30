## 🛠️ Setup Instructions

### Backend Setup

1. **Clone repository**
   ```bash
   git clone <repository-url>
   cd streamsync-lite/backend

2. **Install dependencies**
   ```bash
   npm install

3. **Environment setup**
  ```bash
    cp .env.example .env

4. **Create MySQL database**
  ```bash
    mysql -u root -p -e "CREATE DATABASE streamsync;"

5. **CStart backend**
  ```bash
    # Development
    npm run dev

    # Production
    npm start

    # Worker (for notifications)
    npm run worker


  