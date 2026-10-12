const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const DEEZER_ARL = process.env.DEEZER_ARL;

// Function untuk dekripsi Blowfish CBC chunk Deezer
function decryptBlowfishBlock(chunk, key) {
  const cipher = crypto.createDecipheriv('bf-cbc', key, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(chunk), cipher.final()]);
}

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

// 1. Endpoint Search
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
    console.error('Deezer search error:', err.message);
    res.status(500).json({ error: 'Gagal mencari lagu' });
  }
});

// 2. Endpoint Stream Deezer Full Track (Fix Session & Token Handling)
app.get('/api/deezer-stream', async (req, res) => {
  const trackId = req.query.id;
  if (!trackId) return res.status(400).json({ error: 'Track ID dibutuhkan' });

  try {
    const arlValue = (process.env.deezer_cookies || process.env.DEEZER_ARL || '').trim();

    if (!arlValue) {
      return res.status(500).json({ error: 'Cookie Deezer belum diatur di Railway' });
    }

    const baseHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Content-Type': 'application/json'
    };

    // Step 1: Ambil Session API Token & Cookie SID dari Deezer
    const userRes = await axios.post(
      'https://www.deezer.com/ajax/gw-light.php?method=deezer.getUserData&api_version=1.0&api_token=',
      {},
      {
        headers: {
          ...baseHeaders,
          'Cookie': `arl=${arlValue}`
        }
      }
    );

    const apiToken = userRes.data?.results?.checkForm;
    // Tangkap cookie sid dari header set-cookie jika ada
    const setCookieHeaders = userRes.headers['set-cookie'] || [];
    const combinedCookies = [`arl=${arlValue}`, ...setCookieHeaders].join('; ');

    if (!apiToken) {
      console.error('ARL Cookie tidak valid/expired. Response UserData:', userRes.data);
      return res.status(401).json({ error: 'ARL Cookie tidak valid atau expired. Silakan ganti ARL baru.' });
    }

    // Step 2: Ambil Metadata Track & TRACK_TOKEN
    const trackGwRes = await axios.post(
      `https://www.deezer.com/ajax/gw-light.php?method=song.getData&api_version=1.0&api_token=${apiToken}`,
      { sng_id: trackId },
      {
        headers: {
          ...baseHeaders,
          'Cookie': combinedCookies
        }
      }
    );

    const trackData = trackGwRes.data?.results;
    if (!trackData || !trackData.TRACK_TOKEN) {
      console.error('Gagal mendapatkan TRACK_TOKEN. Response GW:', JSON.stringify(trackGwRes.data));
      return res.status(404).json({ error: 'Track token tidak ditemukan dari Deezer' });
    }

    // Step 3: Dapatkan Link Direct CDN
    const mediaRes = await axios.post(
      'https://media.deezer.com/v1/get_url',
      {
        license_token: trackData.TRACK_TOKEN,
        media: [
          {
            type: 'FULL',
            formats: [{ cipher: 'BF_CBC_STRIPE', format: 'MP3_128' }]
          }
        ]
      },
      { headers: baseHeaders }
    );

    const sources = mediaRes.data?.data?.[0]?.media?.[0]?.sources;
    if (!sources || sources.length === 0) {
      return res.status(404).json({ error: 'URL stream tidak tersedia' });
    }

    const audioUrl = sources[0].url;
    const bfKey = getBlowfishKey(trackId);

    // Step 4: Stream & Dekripsi Realtime ke Flutter
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
    console.error('Deezer full stream error:', err.message);
    res.status(500).json({ error: 'Gagal memproses lagu Deezer' });
  }
});

app.listen(PORT, () => {
  console.log(`Server SpotiFLAC running on port ${PORT}`);
});