const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Ambil Cookie ARL dari Environment Variable Railway
const DEEZER_ARL = (process.env.deezer_cookies || process.env.DEEZER_ARL || '').trim();

// 1. Generate Blowfish Key dari Track ID (Kunci Dekripsi Deezer)
function getBlowfishKey(trackId) {
  const SECRET = 'g42fks physical';
  const md5Id = crypto.createHash('md5').update(trackId.toString(), 'ascii').digest('hex');
  
  let key = '';
  for (let i = 0; i < 16; i++) {
    key += String.fromCharCode(
      md5Id.charCodeAt(i) ^ md5Id.charCodeAt(i + 16) ^ SECRET.charCodeAt(i)
    );
  }
  return Buffer.from(key, 'ascii');
}

// 2. Dekripsi Block Blowfish CBC
function decryptBlowfishBlock(chunk, key) {
  const cipher = crypto.createDecipheriv('bf-cbc', key, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(chunk), cipher.final()]);
}

// 3. Endpoint Search Lagu
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

// 4. Endpoint Stream Deezer Full Track (Fix 422 & Signed CDN)
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

    // Step 1: Ambil Session API Token & License Token via getUserData
    const userRes = await axios.post(
      'https://www.deezer.com/ajax/gw-light.php?method=deezer.getUserData&api_version=1.0&api_token=',
      {},
      {
        headers: {
          ...baseHeaders,
          'Cookie': `arl=${DEEZER_ARL}`
        }
      }
    );

    const apiToken = userRes.data?.results?.checkForm;
    // Ambil License Token wajib dari akun Deezer
    const licenseToken = userRes.data?.results?.USER?.OPTIONS?.license_token || userRes.data?.results?.LICENCE_TOKEN;

    const setCookieHeaders = userRes.headers['set-cookie'] || [];
    const combinedCookies = [`arl=${DEEZER_ARL}`, ...setCookieHeaders].join('; ');

    if (!apiToken || !licenseToken) {
      console.error('ARL Cookie kedaluwarsa atau license_token tidak ditemukan:', userRes.data);
      return res.status(401).json({ error: 'ARL Cookie kedaluwarsa/tidak valid. Silakan ganti ARL baru di Railway.' });
    }

    // Step 2: Ambil TRACK_TOKEN lagu via song.getData
    const songRes = await axios.post(
      `https://www.deezer.com/ajax/gw-light.php?method=song.getData&api_version=1.0&api_token=${apiToken}`,
      { sng_id: trackId },
      {
        headers: {
          ...baseHeaders,
          'Cookie': combinedCookies
        }
      }
    );

    const trackToken = songRes.data?.results?.TRACK_TOKEN;
    if (!trackToken) {
      console.error('TRACK_TOKEN tidak ditemukan:', songRes.data);
      return res.status(404).json({ error: 'Track token lagu tidak ditemukan' });
    }

    // Step 3: Minta Signed CDN URL dari media.deezer.com (Sertakan license_token & track_tokens)
    const mediaRes = await axios.post(
      'https://media.deezer.com/v1/get_url',
      {
        license_token: licenseToken,
        track_tokens: [trackToken],
        media: [
          {
            type: "FULL",
            formats: [
              { cipher: "BF_CBC_STRIPE", format: "MP3_128" },
              { cipher: "BF_CBC_STRIPE", format: "MP3_320" }
            ]
          }
        ]
      },
      { headers: baseHeaders }
    );

    const sources = mediaRes.data?.data?.[0]?.media?.[0]?.sources;
    if (!sources || sources.length === 0 || !sources[0].url) {
      console.error('Response media.deezer.com kosong:', mediaRes.data);
      return res.status(404).json({ error: 'URL audio stream tidak ditemukan dari Deezer' });
    }

    const audioUrl = sources[0].url;
    console.log(`[STREAM URL DIRECT FROM DEEZER]: ${audioUrl}`);

    const bfKey = getBlowfishKey(trackId);

    // Step 4: Stream Data Audio & Dekripsi Blowfish Realtime ke Flutter
    const response = await axios({
      method: 'get',
      url: audioUrl,
      responseType: 'stream'
    });

    res.setHeader('Content-Type', 'audio/mpeg');

    let chunkBuffer = Buffer.alloc(0);
    let chunkIndex = 0;

    response.data.on('data', (data) => {
      chunkBuffer = Buffer.concat([chunkBuffer, data]);

      while (chunkBuffer.length >= 2048) {
        const block = chunkBuffer.slice(0, 2048);
        chunkBuffer = chunkBuffer.slice(2048);

        // Tiap block ke-3 dienkripsi Blowfish
        if (chunkIndex % 3 === 0 && block.length === 2048) {
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
    console.error('Deezer stream error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Gagal melakukan streaming lagu Deezer' });
  }
});

app.listen(PORT, () => {
  console.log(`Server SpotiFLAC running on port ${PORT}`);
});

