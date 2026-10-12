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

// Endpoint Streaming langsung merender audio via FFmpeg ke Flutter
app.get('/api/stream', (req, res) => {
  const videoId = req.query.id;
  if (!videoId) {
    return res.status(400).json({ error: 'Parameter video ID dibutuhkan' });
  }

  const cleanId = videoId.replace('/', '');
  const youtubeUrl = `https://www.youtube.com/watch?v=${cleanId}`;

  // Set header agar Flutter tahu ini adalah file audio stream (mp3/webm)
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Transfer-Encoding', 'chunked');

  // Jalankan yt-dlp yang langsung di-pipe ke stdout dengan bantuan ffmpeg internal yt-dlp
  const ytProcess = spawn('yt-dlp', [
    '--cookies', 'cookies.txt',
    '--js-runtimes', 'deno',
    '--remote-components', 'ejs:github',
    '-f', 'bestaudio',
    '-x', // Extract audio
    '--audio-format', 'mp3', // Konversi otomatis ke MP3 standar yang pasti bunyi
    '-o', '-', // Output ke stdout agar bisa di-pipe ke Express
    youtubeUrl
  ]);

  ytProcess.stdout.pipe(res);

  ytProcess.stderr.on('data', (data) => {
    console.error(`yt-dlp log: ${data.toString()}`);
  });

  ytProcess.on('error', (err) => {
    console.error(`Process error: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Gagal memproses audio stream' });
    }
  });

  // Hentikan proses jika klien Flutter menutup koneksi
  req.on('close', () => {
    ytProcess.kill('SIGKILL');
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
});