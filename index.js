const express = require('express');
const cors = require('cors');
const fs = require('fs');
const { exec, execSync } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());

// 1. Memperbarui yt-dlp dan dependensi saat server booting di Railway
try {
  console.log("Memperbarui yt-dlp ke versi terbaru...");
  execSync('pip install --upgrade --break-system-packages "yt-dlp[default]"');
  execSync('yt-dlp -U');
} catch (err) {
  console.log("Catatan update yt-dlp:", err.message);
}

// 2. Menulis cookies Netscape dari Environment Variable Railway dengan pembersihan format baris
if (process.env.YOUTUBE_COOKIES) {
  const cleanCookies = process.env.YOUTUBE_COOKIES.replace(/\r\n/g, '\n').trim();
  fs.writeFileSync('./cookies.txt', cleanCookies);
  console.log("File cookies.txt berhasil disiapkan dan dibersihkan.");
}

// 3. Endpoint untuk pengecekan status server
app.get('/', (req, res) => {
  res.status(200).json({ status: 'active', message: 'SpotiFLAC Backend Running' });
});

// 4. Endpoint utama untuk mengambil Stream URL YouTube via yt-dlp
app.get('/api/stream', (req, res) => {
  const videoId = req.query.id;
  if (!videoId) {
    return res.status(400).json({ error: 'Parameter video ID dibutuhkan' });
  }

  // Bersihkan ID dari karakter ekstra (misal garis miring)
  const cleanId = videoId.replace('/', '');
  const youtubeUrl = `https://www.youtube.com/watch?v=${cleanId}`;

  // Perintah yt-dlp menggunakan --js-runtimes deno sesuai environment Railway
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

// 5. Jalankan server pada port Railway atau port default 8080
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
});
