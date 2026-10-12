const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { Transform } = require('stream');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const DEEZER_ARL = (process.env.deezer_cookies || process.env.DEEZER_ARL || '').trim();

// 1. Generator Kunci Blowfish dari SNG_ID Asli
function getBlowfishKey(sngId) {
  const SECRET = 'g42fks physical';
  const md5Id = crypto.createHash('md5').update(sngId.toString(), 'ascii').digest('hex');
  
  const bfKey = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) {
    const secretCode = i < SECRET.length ? SECRET.charCodeAt(i) : 0;
    bfKey[i] = md5Id.charCodeAt(i) ^ md5Id.charCodeAt(i + 16) ^ secretCode;
  }
  return bfKey;
}

// 2. Dekripsi Block Blowfish CBC
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

// 3. Transform Stream Dekripsi 2048 Bytes
class DeezerDecryptor extends Transform {
  constructor(bfKey) {
    super();
    this.bfKey = bfKey;
    this.buffer = Buffer.alloc(0);
    this.chunkIndex = 0;
  }

  _transform(chunk, encoding, callback) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 2048) {
      const block = this.buffer.subarray(0, 2048);
      this.buffer = this.buffer.subarray(2048);

      if (this.chunkIndex % 3 === 0) {
        const decryptedBlock = decryptBlowfishBlock(block, this.bfKey);
        this.push(decryptedBlock);
      } else {
        this.push(block);
      }
      this.chunkIndex++;
    }
    callback();
  }

  _flush(callback) {
    if (this.buffer.length > 0) {
      this.push(this.buffer);
    }
    callback();
  }
}

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

    // Step 2: Song Data & SNG_ID Asli
    const songRes = await axios.post(
      `https://www.deezer.com/ajax/gw-light.php?method=song.getData&api_version=1.0&api_token=${apiToken}`,
      { sng_id: trackId },
      { headers: { ...baseHeaders, 'Cookie': combinedCookies } }
    );

    const songData = songRes.data?.results;
    // Ambil SNG_ID resmi dari response Deezer
    const realSngId = songData?.SNG_ID || songData?.DATA?.SNG_ID || trackId;
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

    console.log(`[PIPELINE ACTIVE] Real SNG_ID: ${realSngId} | URL: ${audioUrl}`);

    // Kunci Blowfish dibuat berdasarkan SNG_ID asli
    const bfKey = getBlowfishKey(realSngId);

    // Step 4: Stream CDN -> Decryptor -> FFmpeg -> Res
    const cdnResponse = await axios({
      method: 'get',
      url: audioUrl,
      responseType: 'stream'
    });

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'none');

    const decryptor = new DeezerDecryptor(bfKey);

    req.on('close', () => {
      cdnResponse.data.destroy();
      decryptor.destroy();
    });

    ffmpeg(cdnResponse.data.pipe(decryptor))
      .inputFormat('mp3')
      .audioCodec('libmp3lame')
      .audioBitrate('128k')
      .audioFrequency(44100)
      .audioChannels(2)
      .format('mp3')
      .on('error', (err) => {
        if (!err.message.includes('Output stream closed')) {
          console.error('FFmpeg processing error:', err.message);
        }
      })
      .pipe(res, { end: true });

  } catch (err) {
    console.error('Deezer stream error:', err.response?.status || err.message);
    res.status(err.response?.status || 500).json({ error: 'Gagal melakukan streaming lagu Deezer' });
  }
});

app.listen(PORT, () => {
  console.log(`Server SpotiFLAC running on port ${PORT}`);
});

