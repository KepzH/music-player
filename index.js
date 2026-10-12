const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Middleware CORS agar Flutter Mobile / Web tidak terblokir
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
  next();
});

const DEEZER_ARL = (process.env.deezer_cookies || process.env.DEEZER_ARL || '').trim();

// 1. Helper Kunci Blowfish
function getBlowfishKey(trackId) {
  const SECRET = 'g42fks physical';
  const md5Id = crypto.createHash('md5').update(trackId.toString(), 'ascii').digest('hex');
  
  const bfKey = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) {
    const secCode = i < SECRET.length ? SECRET.charCodeAt(i) : 0;
    bfKey[i] = md5Id.charCodeAt(i) ^ md5Id.charCodeAt(i + 16) ^ secCode;
  }
  return bfKey;
}

// 2. Dekripsi Block Blowfish CBC
function decryptBlowfishBlock(chunk, key) {
  try {
    const cipher = crypto.createDecipheriv('bf-cbc', key, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(chunk), cipher.final()]);
  } catch (e) {
    return chunk;
  }
}

// Helper untuk Cek Header MP3 / ID3
function isAudioHeaderValid(buffer) {
  if (!buffer || buffer.length < 3) return false;
  const isID3 = buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33; // 'ID3'
  const isMP3Sync = buffer[0] === 0xFF && (buffer[1] & 0xE0) === 0xE0; // MP3 Sync Frame
  return isID3 || isMP3Sync;
}

// Search Endpoint
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
      duration: item.duration,
      type: 'deezer'
    }));

    res.json({ results: tracks });
  } catch (err) {
    res.status(500).json({ error: 'Gagal mencari lagu' });
  }
});

// Stream Endpoint
app.get('/api/deezer-stream', async (req, res) => {
  const trackId = req.query.id;
  if (!trackId) return res.status(400).json({ error: 'Track ID dibutuhkan' });

  if (!DEEZER_ARL) {
    return res.status(500).json({ error: 'Cookie deezer_cookies belum dipasang di Railway' });
  }

  try {
    const baseHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Content-Type': 'application/json'
    };

    // Step 1: User Data & License Token
    const userRes = await axios.post(
      'https://www.deezer.com/ajax/gw-light.php?method=deezer.getUserData&api_version=1.0&api_token=',
      {},
      { headers: { ...baseHeaders, 'Cookie': `arl=${DEEZER_ARL}` } }
    );

    const apiToken = userRes.data?.results?.checkForm;
    const licenseToken = userRes.data?.results?.USER?.OPTIONS?.license_token || userRes.data?.results?.LICENCE_TOKEN;
    const setCookieHeaders = userRes.headers['set-cookie'] || [];
    const combinedCookies = [`arl=${DEEZER_ARL}`, ...setCookieHeaders].join('; ');

    if (!apiToken || !licenseToken) {
      return res.status(401).json({ error: 'ARL Cookie kedaluwarsa atau tidak valid' });
    }

    // Step 2: Song Data & TRACK_TOKEN
    const songRes = await axios.post(
      `https://www.deezer.com/ajax/gw-light.php?method=song.getData&api_version=1.0&api_token=${apiToken}`,
      { sng_id: trackId },
      { headers: { ...baseHeaders, 'Cookie': combinedCookies } }
    );

    const realTrackId = songRes.data?.results?.SNG_ID || trackId;
    const trackToken = songRes.data?.results?.TRACK_TOKEN;
    if (!trackToken) {
      return res.status(404).json({ error: 'Track token lagu tidak ditemukan' });
    }

    // Step 3: Stream CDN URL
    const mediaRes = await axios.post(
      'https://media.deezer.com/v1/get_url',
      {
        license_token: licenseToken,
        track_tokens: [trackToken],
        media: [
          {
            type: "FULL",
            formats: [{ cipher: "BF_CBC_STRIPE", format: "MP3_128" }]
          }
        ]
      },
      { headers: baseHeaders }
    );

    const audioUrl = mediaRes.data?.data?.[0]?.media?.[0]?.sources?.[0]?.url;
    if (!audioUrl) {
      return res.status(404).json({ error: 'URL audio stream tidak ditemukan dari Deezer' });
    }

    const bfKey = getBlowfishKey(realTrackId);

    // Step 4: Stream Audio dengan Auto-Detection Enkripsi
    const response = await axios({
      method: 'get',
      url: audioUrl,
      responseType: 'stream'
    });

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'none');

    let chunkBuffer = Buffer.alloc(0);
    let chunkIndex = 0;
    let isEncryptedStream = null;

    response.data.on('data', (data) => {
      chunkBuffer = Buffer.concat([chunkBuffer, data]);

      while (chunkBuffer.length >= 2048) {
        const block = chunkBuffer.subarray(0, 2048);
        chunkBuffer = chunkBuffer.subarray(2048);

        // Deteksi otomatis status enkripsi pada blok pertama
        if (isEncryptedStream === null) {
          if (isAudioHeaderValid(block)) {
            isEncryptedStream = false;
            console.log('[DEEZER STREAM]: Stream terdeteksi Plaintext (Unencrypted)');
          } else {
            const testDecrypted = decryptBlowfishBlock(block, bfKey);
            if (isAudioHeaderValid(testDecrypted)) {
              isEncryptedStream = true;
              console.log('[DEEZER STREAM]: Stream terdeteksi Encrypted (Blowfish)');
            } else {
              isEncryptedStream = true;
            }
          }
        }

        // Dekripsi hanya dilakukan jika stream memang terenkripsi
        if (isEncryptedStream && chunkIndex % 3 === 0 && block.length === 2048) {
          const decryptedBlock = decryptBlowfishBlock(block, bfKey);
          res.write(decryptedBlock);
        } else {
          res.write(block);
        }
        chunkIndex++;
      }
    });

    response.data.on('end', () => {
      if (chunkBuffer.length > 0) {
        res.write(chunkBuffer);
      }
      res.end();
    });

  } catch (err) {
    console.error('Deezer stream error:', err.message);
    res.status(500).json({ error: 'Gagal melakukan streaming lagu Deezer' });
  }
});

app.listen(PORT, () => {
  console.log(`Server SpotiFLAC running on port ${PORT}`);
});


