const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Middleware CORS untuk Flutter (Mobile, Web, & Desktop)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const DEEZER_ARL = (process.env.deezer_cookies || process.env.DEEZER_ARL || '').trim();

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

// 2. Dekripsi Block Blowfish CBC (2048 Bytes)
function decryptBlowfishBlock(chunk, key) {
  try {
    const iv = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]);
    const decipher = crypto.createDecipheriv('bf-cbc', key, iv);
    decipher.setAutoPadding(false);
    return Buffer.concat([decipher.update(chunk), decipher.final()]);
  } catch (err) {
    return chunk;
  }
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

    // Step 3: Stream CDN URL dengan format wajib BF_CBC_STRIPE
    const mediaRes = await axios.post(
      'https://media.deezer.com/v1/get_url',
      {
        license_token: licenseToken,
        track_tokens: [trackToken],
        media: [
          {
            type: "FULL",
            formats: [
              { cipher: "BF_CBC_STRIPE", format: "MP3_128" }
            ]
          }
        ]
      },
      { headers: baseHeaders }
    );

    const audioUrl = mediaRes.data?.data?.[0]?.media?.[0]?.sources?.[0]?.url;
    if (!audioUrl) {
      return res.status(404).json({ error: 'URL audio stream tidak ditemukan dari Deezer' });
    }

    console.log(`[STREAMING ACTIVE] Track ID: ${realSngId}`);

    const bfKey = getBlowfishKey(realSngId);

    // Step 4: Stream Audio dari CDN Deezer
    const cdnResponse = await axios({
      method: 'get',
      url: audioUrl,
      responseType: 'stream'
    });

    // Set Header Kunci: Melarang Range Request agar siklus dekripsi 2048-bytes konsisten
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'none');

    req.on('close', () => {
      cdnResponse.data.destroy();
    });

    let chunkBuffer = Buffer.alloc(0);
    let chunkIndex = 0;

    cdnResponse.data.on('data', (data) => {
      chunkBuffer = Buffer.concat([chunkBuffer, data]);

      while (chunkBuffer.length >= 2048) {
        const block = chunkBuffer.subarray(0, 2048);
        chunkBuffer = chunkBuffer.subarray(2048);

        // Hanya dekripsi blok ke-0, 3, 6, 9...
        if (chunkIndex % 3 === 0) {
          const decryptedBlock = decryptBlowfishBlock(block, bfKey);
          res.write(decryptedBlock);
        } else {
          res.write(block);
        }
        chunkIndex++;
      }
    });

    cdnResponse.data.on('end', () => {
      if (chunkBuffer.length > 0) {
        res.write(chunkBuffer);
      }
      res.end();
    });

  } catch (err) {
    console.error('Deezer stream error:', err.response?.status || err.message);
    res.status(err.response?.status || 500).json({ error: 'Gagal melakukan streaming lagu Deezer' });
  }
});

app.listen(PORT, () => {
  console.log(`Server SpotiFLAC running on port ${PORT}`);
});

