const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');

// Masukkan direktori Deno ke environment PATH secara otomatis agar terbaca yt-dlp
const denoBinPath = path.join(process.env.HOME || '/root', '.deno', 'bin');
process.env.PATH = `${denoBinPath}:${process.env.PATH}`;

const app = express();
app.use(cors());
app.use(express.json());

// Pastikan yt-dlp dan komponen EJS selalu siap
try {
  console.log("Memeriksa/memperbarui yt-dlp...");
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

  // Perintah standar yt-dlp dengan dukungan Deno & EJS komponen
  const command = `yt-dlp --cookies cookies.txt --js-runtimes deno --remote-components ejs:github -g -f "bestaudio" "${youtubeUrl}"`;
  
  exec(command, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error yt-dlp: ${error.message}`);
      return res.status(500).json({ error: 'Gagal mengambil audio stream', details: stderr });
    }

    const streamUrl = stdout.trim().split('\n')[0];
    if (!streamUrl) {
      return res.status(500).json({ error: 'Stream URL kosong dari yt-dlp' });
    }

    return res.status(200).json({
      status: 'success',
      id: cleanId,
      stream_url: streamUrl,
    });
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
});
