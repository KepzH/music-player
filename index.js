const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Ambil ARL dari Environment Variable Railway
const DEEZER_ARL = (process.env.deezer_cookies || process.env.DEEZER_ARL || '').trim();

// 1. Generate Blowfish Key dari Track ID (Metode Standar Deezer Client)
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

// 3. Generate Direct CDN Media URL (Menghindari Error 422)
function getCdnUrl(md5Origin, mediaVersion, trackId, format = 1) {
  // Format: 1 = MP3_128, 3 = MP3_320, 9 = FLAC
  const magicChar = md5Origin[0];
  const step1 = `${md5Origin}¤${format}¤${trackId}¤${mediaVersion}`;
  const md5Step1 = crypto.createHash('md5').update(step1, 'ascii').digest('hex');
  const path = `${md5Origin[0]}/${md5Origin[1]}/${md5Origin[2]}/${md5Step1}_${format}.mp3`;
  
  return `https://e-cdns-stream-${magicChar}.dzcdn.net/mobile/1/${path}`;
}

// Function pembuat daftar kandidat URL CDN Deezer yang valid
function getCdnUrls(md5Origin, mediaVersion, trackId, format = 1) {
  const magicChar = md5Origin[0];
  const step1 = `${md5Origin}¤${format}¤${trackId}¤${mediaVersion}`;
  const md5Step1 = crypto.createHash('md5').update(step1, 'ascii').digest('hex');
  const path = `${md5Origin[0]}/${md5Origin[1]}/${md5Origin[2]}/${md5Step1}_${format}.mp3`;

  // Daftar host CDN aktif Deezer
  return [
    `https://cdns-stream-${magicChar}.dzcdn.net/mobile/1/${path}`,
    `https://cdns-proxy-${magicChar}.dzcdn.net/mobile/1/${path}`,
    `https://e-cdn-proxy-${magicChar}.dzcdn.net/mobile/1/${path}`
  ];
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

// Endpoint Stream Deezer Full Track (Debug Logging & SID Cookie Fix)
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

    // Step 1: Ambil Session API Token & Cookie Set-Cookie (SID)
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
    // Ambil cookie sid yang diberikan oleh Deezer saat getUserData
    const setCookieHeaders = userRes.headers['set-cookie'] || [];
    const combinedCookies = [`arl=${DEEZER_ARL}`, ...setCookieHeaders].join('; ');

    if (!apiToken) {
      console.error('ARL Cookie ditolak oleh Deezer:', userRes.data);
      return res.status(401).json({ error: 'ARL Cookie kedaluwarsa atau tidak valid' });
    }

    // Step 2: Ambil Song Data (MD5_ORIGIN & MEDIA_VERSION)
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

    // DEBUG LOG: Cetak isi balasan asli dari Deezer ke Railway Logs
    console.log(`[DEEZER GW RESPONSE for Track ID ${trackId}]:`, JSON.stringify(songRes.data));

    const trackData = songRes.data?.results;
    if (!trackData || !trackData.MD5_ORIGIN) {
      console.error(`Metadata MD5_ORIGIN tidak ada di respons. Isinya:`, trackData);
      return res.status(404).json({ error: 'Metadata lagu tidak ditemukan di Deezer' });
    }

    // Step 3: Dapatkan kandidat URL CDN
    const cdnUrls = getCdnUrls(trackData.MD5_ORIGIN, trackData.MEDIA_VERSION, trackId, 1);
    const bfKey = getBlowfishKey(trackId);

    // Step 4: Coba stream dari kandidat URL CDN secara berurutan
    let response = null;
    let activeUrl = '';

    for (const url of cdnUrls) {
      try {
        console.log(`[TRYING CDN URL]: ${url}`);
        response = await axios({
          method: 'get',
          url: url,
          responseType: 'stream'
        });
        activeUrl = url;
        break; // Berhasil terhubung ke CDN
      } catch (err) {
        console.warn(`[CDN FAILED ${url}]:`, err.message);
      }
    }

    if (!response) {
      return res.status(502).json({ error: 'Semua server CDN Deezer tidak dapat dijangkau' });
    }

    console.log(`[SUCCESSFULLY STREAMING FROM]: ${activeUrl}`);
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
    console.error('Deezer stream error:', err.message);
    res.status(500).json({ error: 'Gagal melakukan streaming lagu Deezer' });
  }
});


app.listen(PORT, () => {
  console.log(`Server SpotiFLAC Nofuf-Mode running on port ${PORT}`);
});
