const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Blowfish } = require('blowfish-node');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Middleware CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const DEEZER_ARL = (process.env.deezer_cookies || process.env.DEEZER_ARL || '').trim();

// Cache folder sementara di Railway
const CACHE_DIR = path.join('/tmp', 'deezer_cache');
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// 1. Generator Kunci Blowfish dari SNG_ID
function getBlowfishKey(trackId) {
  const SECRET = 'g42fks physical';
  const md5Id = crypto.createHash('md5').update(trackId.toString(), 'ascii').digest('hex');
  
  const bfKey = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) {
    const secretCode = i < SECRET.length ? SECRET.charCodeAt(i) : 0;
    bfKey[i] = md5Id.charCodeAt(i) ^ md5Id.charCodeAt(i + 16) ^ secretCode;
  }
  return bfKey;
}

// 2. Dekripsi Block 2048 Bytes Menggunakan Pure JS Blowfish CBC
function decryptBlowfishBlockPureJS(chunk, key) {
  try {
    const bf = new Blowfish(key, Blowfish.MODE.CBC, Blowfish.PADDING.PKCS5);
    bf.setIv(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
    
    // Dekripsi 2048 bytes secara presisi tanpa OpenSSL native
    return Buffer.from(bf.decode(chunk, Blowfish.TYPE.UINT8_ARRAY));
  } catch (err) {
    return chunk;
  }
}

// 3. Dekripsi Utuh File Audio
function decryptAudioBuffer(rawBuffer, bfKey) {
  const decryptedChunks = [];
  let offset = 0;
  let chunkIndex = 0;

  while (offset < rawBuffer.length) {
    const blockSize = Math.min(2048, rawBuffer.length - offset);
    const block = rawBuffer.subarray(offset, offset + blockSize);

    if (chunkIndex % 3 === 0 && blockSize === 2048) {
      decryptedChunks.push(decryptBlowfishBlockPureJS(block, bfKey));
    } else {
      decryptedChunks.push(block);
    }

    offset += blockSize;
    chunkIndex++;
  }

  return Buffer.concat(decryptedChunks);
}

// Endpoint Search
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

// Endpoint Stream
app.get('/api/deezer-stream', async (req, res) => {
  const trackId = req.query.id;
  if (!trackId) return res.status(400).json({ error: 'Track ID dibutuhkan' });

  if (!DEEZER_ARL) {
    return res.status(500).json({ error: 'Cookie deezer_cookies belum dipasang di Railway' });
  }

  const cachedFilePath = path.join(CACHE_DIR, `${trackId}.mp3`);

  try {
    if (fs.existsSync(cachedFilePath)) {
      console.log(`[CACHE HIT]: Serving ${trackId}.mp3`);
      return res.sendFile(cachedFilePath, {
        headers: {
          'Content-Type': 'audio/mpeg',
          'Accept-Ranges': 'bytes'
        }
      });
    }

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

    // Step 2: Song Data & REAL SNG_ID
    const songRes = await axios.post(
      `https://www.deezer.com/ajax/gw-light.php?method=song.getData&api_version=1.0&api_token=${apiToken}`,
      { sng_id: trackId },
      { headers: { ...baseHeaders, 'Cookie': combinedCookies } }
    );

    const songData = songRes.data?.results;
    const realSngId = songData?.SNG_ID || trackId;
    const trackToken = songData?.TRACK_TOKEN;

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

    console.log(`[PURE JS DECRYPT START] Track ID: ${realSngId}`);

    // Step 4: Download buffer audio utuh
    const audioDownload = await axios.get(audioUrl, { responseType: 'arraybuffer' });
    const rawBuffer = Buffer.from(audioDownload.data);

    // Step 5: Dekripsi Blowfish dengan Pure JS
    const bfKey = getBlowfishKey(realSngId);
    const decryptedBuffer = decryptAudioBuffer(rawBuffer, bfKey);

    // Simpan ke disk cache sementara
    fs.writeFileSync(cachedFilePath, decryptedBuffer);

    // Step 6: Kirim via sendFile
    return res.sendFile(cachedFilePath, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Accept-Ranges': 'bytes'
      }
    });

  } catch (err) {
    console.error('Deezer stream error:', err.message);
    res.status(500).json({ error: 'Gagal melakukan streaming lagu Deezer' });
  }
});

app.listen(PORT, () => {
  console.log(`Server SpotiFLAC running on port ${PORT}`);
});

