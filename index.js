const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

// Daftarkan folder Deno ke environment PATH
const denoBinPath = path.join(process.env.HOME || '/root', '.deno', 'bin');
process.env.PATH = `${denoBinPath}:${process.env.PATH}`;

const app = express();
app.use(cors());
app.use(express.json());

// Pastikan yt-dlp selalu up-to-date saat booting
try {
  console.log("Memperbarui yt-dlp...");
  execSync('pip install --upgrade --break-system-packages "yt-dlp[default]"');
} catch (err) {
  console.log("Catatan pip:", err.message);
}

// Menulis cookies Netscape dari Environment Variable Railway
if (process.env.YOUTUBE_COOKIES) {
  const cleanCookies = process.env.YOUTUBE_COOKIES.replace(/\r\n/g, '\n').trim();
  fs.writeFileSync('./cookies.txt', cleanCookies);
  console.log("File cookies.txt berhasil disiapkan.");
}

app.get('/', (req, res) => {
  res.status(200).json({ status: 'active', message: 'SpotiFLAC Backend Running' });
});

// Endpoint untuk mencari lagu/video
// Endpoint untuk mencari lagu/video (Versi Ringan & Cepat)
app.get('/api/search', (req, res) => {
  const searchQuery = req.query.q;
  if (!searchQuery) {
    return res.status(400).json({ error: 'Parameter query q dibutuhkan' });
  }

  const ytSearch = spawn('yt-dlp', [
    '--cookies', 'cookies.txt',
    '--js-runtimes', 'deno',
    '--remote-components', 'ejs:github',
    '--dump-json',
    '--default-search', 'ytsearch10',
    searchQuery
  ]);

  let dataBuffer = '';

  ytSearch.stdout.on('data', (chunk) => {
    dataBuffer += chunk;
  });

  ytSearch.stderr.on('data', (data) => {
    // Abaikan error kecil
  });

  ytSearch.on('close', (code) => {
    if (code !== 0) {
      return res.status(500).json({ error: 'Gagal melakukan pencarian' });
    }

    try {
      const lines = dataBuffer.trim().split('\n').filter(line => line.length > 0);
      const results = lines.map(line => {
        try {
          const item = JSON.parse(line);
          return {
            id: item.id || '',
            title: item.title || 'Tanpa Judul',
            artist: item.uploader || item.channel || 'Artis Tidak Diketahui',
            thumbnail: item.thumbnail || (item.thumbnails && item.thumbnails.length > 0 ? item.thumbnails[0].url : ''),
          };
        } catch (e) {
          return null;
        }
      }).filter(item => item !== null && item.id !== '');

      res.status(200).json(results);
    } catch (e) {
      res.status(500).json({ error: 'Gagal memparsing hasil pencarian' });
    }
  });

  req.on('close', () => {
    ytSearch.kill('SIGKILL');
  });
});

app.get('/api/stream', (req, res) => {
  const videoId = req.query.id;
  if (!videoId) {
    return res.status(400).json({ error: 'Parameter video ID dibutuhkan' });
  }

  const cleanId = videoId.replace('/', '');
  const youtubeUrl = `https://www.youtube.com/watch?v=${cleanId}`;

  // Set header untuk streaming audio
  res.setHeader('Content-Type', 'audio/webm');
  res.setHeader('Transfer-Encoding', 'chunked');

  const ytProcess = spawn('yt-dlp', [
    '--cookies', 'cookies.txt',
    '--js-runtimes', 'deno',
    '--remote-components', 'ejs:github',
    '-f', 'bestaudio',
    '-o', '-',
    youtubeUrl
  ]);

  ytProcess.stdout.pipe(res);

  ytProcess.stderr.on('data', (data) => {
    const logStr = data.toString();
    if (logStr.includes('ERROR') || logStr.includes('WARNING')) {
      console.error(`yt-dlp log: ${logStr}`);
    }
  });

  ytProcess.on('error', (err) => {
    console.error(`Process error: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Gagal memproses audio stream' });
    }
  });

  req.on('close', () => {
    ytProcess.kill('SIGKILL');
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
});