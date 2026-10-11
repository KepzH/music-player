const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const app = express();

app.use(cors());
app.use(express.json());

// Endpoint untuk tes server
app.get('/', (req, res) => {
  res.send({ status: 'active', message: 'SpotiFLAC Backend Running' });
});

// Endpoint untuk mengambil Stream URL via yt-dlp
app.get('/api/stream', (req, res) => {
  const videoId = req.query.id;
  if (!videoId) {
    return res.status(400).json({ error: 'Parameter video ID dibutuhkan' });
  }

  const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // Ditambahkan --extractor-args untuk melewati proteksi bot YouTube
  const command = `yt-dlp -g -f "bestaudio" --extractor-args "youtube:player_client=tv,mweb" "${youtubeUrl}"`;
  
  exec(command, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error yt-dlp: ${error.message}`);
      return res.status(500).json({ error: 'Gagal mengambil audio stream', details: stderr });
    }

    const streamUrl = stdout.trim();
    return res.json({
      status: 'success',
      id: videoId,
      stream_url: streamUrl,
    });
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
});