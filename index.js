const express = require('express');
const cors = require('cors');
const fs = require('fs');
const { exec, execSync } = require('child_process');
const app = express();

app.use(cors());
app.use(express.json());

// Memaksa yt-dlp update ke versi terbaru & pastikan dependensi EJS terpasang
try {
  console.log("Memperbarui yt-dlp ke versi terbaru...");
  execSync('pip install --upgrade --break-system-packages "yt-dlp[default]"');
  execSync('yt-dlp -U');
} catch (err) {
  console.log("Catatan update yt-dlp:", err.message);
}

// Menulis cookies ke cookies.txt agar sinkron dengan argumen --cookies cookies.txt
if (process.env.YOUTUBE_COOKIES) {
  fs.writeFileSync('./cookies.txt', process.env.YOUTUBE_COOKIES);
}

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

  // Bersihkan ID jika ada karakter ekstra (seperti garis miring di akhir)
  const cleanId = videoId.replace('/', '');
  const youtubeUrl = `https://www.youtube.com/watch?v=${cleanId}`;

  // Perintah yt-dlp lengkap dengan argumen bypass signature & runtime Node.js
  const command = `yt-dlp --cookies cookies.txt --js-runtimes node --remote-components ejs:github -g -f "bestaudio" "${youtubeUrl}"`;
  
  exec(command, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error yt-dlp: ${error.message}`);
      return res.status(500).json({ error: 'Gagal mengambil audio stream', details: stderr });
    }

    const streamUrl = stdout.trim().split('\n')[0];
    if (!streamUrl) {
      return res.status(500).json({ error: 'Stream URL kosong dari yt-dlp' });
    }

    return res.json({
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
