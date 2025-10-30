const express = require('express');
const axios = require('axios');
const { parseString } = require('xml2js');
const { authenticateToken } = require('../middleware/auth');
const { pool } = require('../config/database');

const router = express.Router();

// Get latest videos from RSS feed
router.get('/latest', async (req, res) => {
  try {
    const channelId = req.query.channelId || process.env.DEFAULT_YOUTUBE_CHANNEL_ID;
    
    if (!channelId) {
      return res.status(400).json({ error: 'Channel ID is required' });
    }

    // Check cache first
    const [cachedVideos] = await pool.execute(
      `SELECT * FROM videos 
       WHERE channel_id = ? 
       AND created_at > DATE_SUB(NOW(), INTERVAL 10 MINUTE)
       ORDER BY published_at DESC 
       LIMIT 10`,
      [channelId]
    );

    if (cachedVideos.length > 0) {
      return res.json(cachedVideos);
    }

    // Fetch from YouTube RSS feed
    const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
    const response = await axios.get(rssUrl);
    
    const videos = await parseRssFeed(response.data, channelId);
    
    // Cache videos
    await cacheVideos(videos);
    
    res.json(videos);
  } catch (error) {
    console.error('Error fetching videos from RSS:', error);
    
    // Fallback to cached videos
    const [cachedVideos] = await pool.execute(
      'SELECT * FROM videos WHERE channel_id = ? ORDER BY published_at DESC LIMIT 10',
      [req.query.channelId || process.env.DEFAULT_YOUTUBE_CHANNEL_ID]
    );
    
    res.json(cachedVideos);
  }
});

// Parse RSS feed
async function parseRssFeed(xmlData, channelId) {
  return new Promise((resolve, reject) => {
    parseString(xmlData, (err, result) => {
      if (err) {
        reject(err);
        return;
      }

      try {
        const entries = result.feed.entry || [];
        const videos = entries.slice(0, 10).map(entry => {
          const videoId = entry['yt:videoId'][0];
          const title = entry.title[0];
          const published = entry.published[0];
          const media = entry['media:group'][0];
          const description = media['media:description'][0] || '';
          const thumbnail = media['media:thumbnail'][0].$.url;

          // Extract duration from media content if available
          let durationSeconds = 0;
          if (media['yt:duration']) {
            durationSeconds = parseInt(media['yt:duration'][0].$.seconds);
          }

          return {
            video_id: videoId,
            title: title,
            description: description,
            thumbnail_url: thumbnail,
            channel_id: channelId,
            published_at: new Date(published),
            duration_seconds: durationSeconds
          };
        });

        resolve(videos);
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

// Cache videos to database
async function cacheVideos(videos) {
  for (const video of videos) {
    try {
      await pool.execute(
        `INSERT INTO videos (video_id, title, description, thumbnail_url, channel_id, published_at, duration_seconds)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
         title=VALUES(title), description=VALUES(description), thumbnail_url=VALUES(thumbnail_url)`,
        [video.video_id, video.title, video.description, video.thumbnail_url, 
         video.channel_id, video.published_at, video.duration_seconds]
      );
    } catch (error) {
      console.error('Error caching video:', error);
    }
  }
}

// Get single video (updated)
router.get('/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;

    const [videos] = await pool.execute(
      'SELECT * FROM videos WHERE video_id = ?',
      [videoId]
    );

    if (videos.length === 0) {
      // If not in cache, get basic info from RSS
      const channelId = process.env.DEFAULT_YOUTUBE_CHANNEL_ID;
      const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
      const response = await axios.get(rssUrl);
      const allVideos = await parseRssFeed(response.data, channelId);
      
      const video = allVideos.find(v => v.video_id === videoId);
      if (video) {
        await cacheVideos([video]);
        return res.json(video);
      }
      
      return res.status(404).json({ error: 'Video not found' });
    }

    res.json(videos[0]);
  } catch (error) {
    console.error('Error fetching video:', error);
    res.status(500).json({ error: 'Failed to fetch video' });
  }
});

// Save progress
router.post('/progress', authenticateToken, async (req, res) => {
  try {
    const { videoId, positionSeconds, completedPercent } = req.body;
    const userId = req.user.id;

    await pool.execute(
      `INSERT INTO progress (user_id, video_id, position_seconds, completed_percent, synced)
       VALUES (?, ?, ?, ?, TRUE)
       ON DUPLICATE KEY UPDATE
       position_seconds=VALUES(position_seconds), 
       completed_percent=VALUES(completed_percent),
       updated_at=CURRENT_TIMESTAMP,
       synced=TRUE`,
      [userId, videoId, positionSeconds, completedPercent]
    );

    res.json({ message: 'Progress saved' });
  } catch (error) {
    console.error('Error saving progress:', error);
    res.status(500).json({ error: 'Failed to save progress' });
  }
});

// Helper function to parse ISO 8601 duration
function parseDuration(duration) {
  const match = duration.match(/PT(\d+H)?(\d+M)?(\d+S)?/);
  const hours = parseInt(match[1]) || 0;
  const minutes = parseInt(match[2]) || 0;
  const seconds = parseInt(match[3]) || 0;
  return hours * 3600 + minutes * 60 + seconds;
}

module.exports = router;