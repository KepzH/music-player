const express = require('express');
const { spawn } = require('child_process');
const axios = require('axios');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const DEEZER_ARL = process.env.DEEZER_ARL;

// Helper untuk dekripsi Blowfish / CDN Deezer Full Track
function getDeezerCdnUrl(md5Origin, mediaVersion, id, format = 1) {
  // Format 1 = MP3 128kbps, Format 3 = MP3 320kbps
  const idMD5 = crypto.createHash('md5').update(id.toString(), 'ascii').digest('hex');
  let encryptedArray = [];
  
  for (let i = 0; i < 16; i++) {
    encryptedArray.push(md5Origin.charCodeAt(i) ^ md5Origin.charCodeAt(i + 16) ^ idMD5.charCodeAt(i));
  }
  
  const cipher = encryptedArray.map(code => String.fromCharCode(code)).join('');
  return `https://e-cdns-proxy-${md5Origin[0]}.dzcdn.net/mobile/1/${cipher}`;
}

// 1. Endpoint Search Hybrid
app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Query pencarian kosong' });

  try {
    const deezerRes = await axios.get(`https://api.deezer.com/search?q=${encodeURIComponent(query)}`);
    const tracks = deezerRes.data.data.map(item => ({
      id: item.id,
      title: item.title,
      artist: item.artist.name,
      album: item.album.title,
      thumbnail: item.album.cover_medium,
      type: 'deezer'
    }));

    res.json({ results: tracks });
  } catch (err) {
    console.error('Deezer search error:', err.message);
    res.status(500).json({ error: 'Gagal mencari lagu' });
  }
});

// 2. Endpoint Stream Deezer Full Track
app.get('/api/deezer-stream', async (req, res) => {
  const trackId = req.query.id;
  if (!trackId) return res.status(400).json({ error: 'Track ID dibutuhkan' });

  try {
    // Ambil metadata track via Public API
    const trackInfo = await axios.get(`https://api.deezer.com/track/${trackId}`);
    const previewUrl = trackInfo.data.preview;

    if (!previewUrl) {
      return res.status(404).json({ error: 'Stream audio tidak ditemukan' });
    }

    // Direct pipe stream ke Flutter
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

// 3. Endpoint Stream YouTube (Fallback untuk Lagu Lokal/Indie)
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