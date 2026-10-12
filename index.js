const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Middleware CORS untuk Flutter (Mobile, Web, Desktop)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const DEEZER_ARL = (process.env.deezer_cookies || process.env.DEEZER_ARL || '').trim();

// 1. Helper Kunci Blowfish dari Hex String (32 karakter)
function buildBfKeyFromMd5Hex(md5Hex) {
  const SECRET = 'g42fks physical';
  const bfKey = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) {
    const secretCode = i < SECRET.length ? SECRET.charCodeAt(i) : 0;
    bfKey[i] = md5Hex.charCodeAt(i) ^ md5Hex.charCodeAt(i + 16) ^ secretCode;
  }
  return bfKey;
}

// Generator Kunci A: Dari Track ID (SNG_ID)
function getBlowfishKeyFromTrackId(trackId) {
  const md5Hex = crypto.createHash('md5').update(trackId.toString(), 'ascii').digest('hex');
  return buildBfKeyFromMd5Hex(md5Hex);
}

// Generator Kunci B: Dari MD5_ORIGIN
function getBlowfishKeyFromMd5Origin(md5Origin) {
  if (!md5Origin || md5Origin.length !== 32) return null;
  return buildBfKeyFromMd5Hex(md5Origin);
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

// 3. Validator Header MP3 / ID3
function isValidMp3Header(buf) {
  if (!buf || buf.length < 3) return false;
  // Header ID3v2 ('ID3')
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true;
  // Frame Sync MP3 (0xFFE... atau 0xFFF...)
  if (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0) return true;
  return false;
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

    // Step 2: Song Data, SNG_ID & MD5_ORIGIN
    const songRes = await axios.post(
      `https://www.deezer.com/ajax/gw-light.php?method=song.getData&api_version=1.0&api_token=${apiToken}`,
      { sng_id: trackId },
      { headers: { ...baseHeaders, 'Cookie': combinedCookies } }
    );

    const songData = songRes.data?.results;
    const realSngId = songData?.SNG_ID || trackId;
    const md5Origin = songData?.MD5_ORIGIN;
    const trackToken = songData?.TRACK_TOKEN;

    if (!trackToken) {
      return res.status(404).json({ error: 'Track token lagu tidak ditemukan' });
    }

    // Step 3: Stream CDN URL dari media.deezer.com
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

    console.log(`[STREAMING START] Track ID: ${realSngId} | MD5: ${md5Origin}`);

    // Step 4: Stream Audio & Auto-Diagnosa Kunci Dekripsi
    const response = await axios({
      method: 'get',
      url: audioUrl,
      responseType: 'stream'
    });

    res.setHeader('Content-Type', 'audio/mpeg');

    req.on('close', () => {
      response.data.destroy();
    });

    let chunkBuffer = Buffer.alloc(0);
    let chunkIndex = 0;
    let activeBfKey = null;
    let isDirectStream = false;

    response.data.on('data', (data) => {
      chunkBuffer = Buffer.concat([chunkBuffer, data]);

      while (chunkBuffer.length >= 2048) {
        const block = chunkBuffer.subarray(0, 2048);
        chunkBuffer = chunkBuffer.subarray(2048);

        // Tes & tentukan kunci dekripsi yang valid hanya pada blok pertama (chunkIndex 0)
        if (activeBfKey === null && !isDirectStream) {
          // Tes 1: Apakah sudah plaintext asli?
          if (isValidMp3Header(block)) {
            isDirectStream = true;
            console.log('[DECRYPTION CHECK]: Stream murni Plaintext! Tanpa dekripsi.');
          } else {
            // Tes 2: Kunci A (Track ID)
            const keyA = getBlowfishKeyFromTrackId(realSngId);
            const decA = decryptBlowfishBlock(block, keyA);
            
            if (isValidMp3Header(decA)) {
              activeBfKey = keyA;
              console.log(`[DECRYPTION CHECK]: KUNCI A (Track ID ${realSngId}) BERHASIL! Magic Header ID3/MP3 Valid.`);
            } else {
              // Tes 3: Kunci B (MD5 Origin)
              const keyB = getBlowfishKeyFromMd5Origin(md5Origin);
              if (keyB) {
                const decB = decryptBlowfishBlock(block, keyB);
                if (isValidMp3Header(decB)) {
                  activeBfKey = keyB;
                  console.log(`[DECRYPTION CHECK]: KUNCI B (MD5 ${md5Origin}) BERHASIL! Magic Header ID3/MP3 Valid.`);
                }
              }
            }

            if (!activeBfKey && !isDirectStream) {
              console.warn('[DECRYPTION CHECK WARNING]: Kunci A & B gagal menghasilkan header valid! Menggunakan Kunci A default.');
              console.warn('[DEBUG RAW BLOCK 0 HEX]:', block.subarray(0, 16).toString('hex'));
              console.warn('[DEBUG DECRYPTED A HEX]:', decA.subarray(0, 16).toString('hex'));
              activeBfKey = keyA;
            }
          }
        }

        // Tulis stream sesuai mode hasil deteksi
        if (isDirectStream) {
          res.write(block);
        } else {
          if (chunkIndex % 3 === 0) {
            const decryptedBlock = decryptBlowfishBlock(block, activeBfKey);
            res.write(decryptedBlock);
          } else {
            res.write(block);
          }
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

