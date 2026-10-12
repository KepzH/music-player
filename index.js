const express = require('express');
const { spawn } = require('child_process');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// 1. Endpoint Search Hybrid (Deezer Utama)
app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Query pencarian kosong' });

  try {
    // Cari ke Deezer API terlebih dahulu
    const deezerRes = await axios.get(`https://api.deezer.com/search?q=${encodeURIComponent(query)}`);
    const tracks = deezerRes.data.data.map(item => ({
      id: item.id,
      title: item.title,
      artist: item.artist.name,
      thumbnail: item.album.cover_medium,
      type: 'deezer', // Penanda bahwa ini lagu resmi/major label
      previewUrl: item.preview
    }));

    res.json({ results: tracks });
  } catch (err) {
    console.error('Deezer search error:', err.message);
    res.status(500).json({ error: 'Gagal mencari lagu' });
  }
});

// 2. Endpoint Stream Deezer (Full Track via Preview/CDN Direct)
app.get('/api/deezer-stream', async (req, res) => {
  const trackId = req.query.id;
  if (!trackId) return res.status(400).json({ error: 'Track ID dibutuhkan' });

  try {
    const trackInfo = await axios.get(`https://api.deezer.com/track/${trackId}`);
    const previewUrl = trackInfo.data.preview; // Preview MP3 Direct URL dari Deezer CDN

    if (!previewUrl) {
      return res.status(404).json({ error: 'Stream audio tidak ditemukan' });
    }

    // Direct pipe stream MP3 dari Deezer ke Flutter
    const audioStream = await axios({
      method: 'get',
      url: previewUrl,
      responseType: 'stream'
    });

    res.setHeader('Content-Type', 'audio/mpeg');
    audioStream.data.pipe(res);
  } catch (err) {
    console.error('Deezer stream error:', err.message);
    res.status(500).json({ error: 'Gagal mengambil audio Deezer' });
  }
});

// 3. Endpoint Stream YouTube (Tetap disediakan untuk lagu lokal/indie)
app.get('/api/stream', (req, res) => {
  const videoId = req.query.id;
  if (!videoId) return res.status(400).json({ error: 'Parameter video ID dibutuhkan' });

  const cleanId = videoId.replace('/', '');
  const youtubeUrl = `https://www.youtube.com/watch?v=${cleanId}`;

  res.setHeader('Content-Type', 'audio/webm');
  res.setHeader('Transfer-Encoding', 'chunked');

  const ytProcess = spawn('yt-dlp', [
    '--cookies', 'cookies.txt',
    '--js-runtimes', 'deno',
    '--remote-components', 'ejs:github',
    '-f', 'bestaudio/best',
    '-o', '-',
    youtubeUrl
  ]);

  ytProcess.stdout.pipe(res);

  ytProcess.stderr.on('data', (data) => {
    const logStr = data.toString();
    if (logStr.includes('ERROR')) console.error(`yt-dlp log: ${logStr}`);
  });

  req.on('close', () => ytProcess.kill('SIGKILL'));
});

app.listen(PORT, () => {
  console.log(`Server SpotiFLAC running on port ${PORT}`);
});