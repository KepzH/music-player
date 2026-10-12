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
    // Sembunyikan log progress download agar terminal railway tidak kotor, tampilkan error saja jika ada
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