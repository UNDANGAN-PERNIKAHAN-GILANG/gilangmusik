const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*';
const YTDLP_PATH = path.join(__dirname, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

// Fungsi pembantu untuk menyiapkan file cookies dari Environment Variable Railway
function getCookieArgs() {
  const cookiesContent = process.env.YOUTUBE_COOKIES;
  if (!cookiesContent) return [];
  
  const cookiePath = path.join(require('os').tmpdir(), 'yt-cookies.txt');
  try {
    fs.writeFileSync(cookiePath, cookiesContent, 'utf-8');
    return ['--cookies', cookiePath];
  } catch (err) {
    console.error('Gagal menulis file cookie:', err);
    return [];
  }
}

function ensureYtDlp() {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(YTDLP_PATH)) {
      try { fs.unlinkSync(YTDLP_PATH); } catch (e) {}
    }

    const https = require('https');
    const isWin = process.platform === 'win32';
    const downloadUrl = isWin
      ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
      : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';

    console.log(`Mendownload yt-dlp versi terbaru untuk ${process.platform}...`);

    function doDownload(targetUrl) {
      https.get(targetUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return doDownload(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Download gagal dengan status ${res.statusCode}`));
        }
        const fileStream = fs.createWriteStream(YTDLP_PATH);
        res.pipe(fileStream);
        fileStream.on('finish', () => {
          fileStream.close();
          if (!isWin) {
            try { fs.chmodSync(YTDLP_PATH, 0o755); } catch (e) {}
          }
          console.log('yt-dlp versi terbaru berhasil didownload!');
          resolve();
        });
      }).on('error', reject);
    }

    doDownload(downloadUrl);
  });
}

app.use(cors({
  origin: FRONTEND_ORIGIN === '*' ? '*' : FRONTEND_ORIGIN.split(',').map(value => value.trim()),
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function sanitizeFilename(name) {
  return (name || 'audio')
    .replace(/[^\w\s.-]/gi, '')
    .trim()
    .replace(/\s+/g, '_')
    .substring(0, 80);
}

// Health check untuk verifikasi Railway
app.get('/health', (_req, res) => res.json({ ok: true }));

// Saran autocomplete YouTube (suggest endpoint); tidak membakar kuota YouTube Data API.
app.get('/api/suggest', async (req, res) => {
  const query = String(req.query.q || '').trim().slice(0, 120);
  if (query.length < 1) return res.json({ success: true, data: [] });
  try {
    const url = new URL('https://suggestqueries.google.com/complete/search');
    url.search = new URLSearchParams({ client: 'firefox', ds: 'yt', q: query }).toString();
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const body = await response.json();
    return res.json({ success: true, data: (body[1] || []).slice(0, 8) });
  } catch (err) {
    return res.json({ success: true, data: [] });
  }
});

// Pencarian via YouTube Data API v3; API key hanya dibaca di backend Railway.
app.get('/api/search', async (req, res) => {
  const query = String(req.query.q || '').trim().slice(0, 200);
  if (!query) return res.status(400).json({ success: false, message: 'Parameter q wajib diisi.' });
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return res.status(503).json({ success: false, message: 'Backend belum dikonfigurasi dengan YOUTUBE_API_KEY.' });

  try {
    const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
    searchUrl.search = new URLSearchParams({ part: 'snippet', maxResults: '10', type: 'video', q: query, key }).toString();
    const searchResponse = await fetch(searchUrl, { signal: AbortSignal.timeout(12000) });
    const searchBody = await searchResponse.json();
    if (!searchResponse.ok) {
      console.error('YouTube search API error:', searchBody.error?.message || searchResponse.status);
      return res.status(searchResponse.status === 403 ? 502 : searchResponse.status).json({ success: false, message: searchBody.error?.message || 'YouTube API gagal mencari video.' });
    }

    const items = searchBody.items || [];
    if (!items.length) return res.json({ success: true, count: 0, data: [] });
    const ids = items.map(item => item.id?.videoId).filter(Boolean);
    const detailUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
    detailUrl.search = new URLSearchParams({ part: 'contentDetails,statistics', id: ids.join(','), key }).toString();
    const detailResponse = await fetch(detailUrl, { signal: AbortSignal.timeout(12000) });
    const detailBody = detailResponse.ok ? await detailResponse.json() : { items: [] };
    const detailMap = new Map((detailBody.items || []).map(video => [video.id, video]));

    const data = items.map(item => {
      const id = item.id.videoId;
      const details = detailMap.get(id);
      const thumb = item.snippet.thumbnails || {};
      return {
        id,
        title: item.snippet.title,
        author: item.snippet.channelTitle || 'Unknown',
        thumbnail: thumb.high?.url || thumb.medium?.url || thumb.default?.url || '',
        url: `https://www.youtube.com/watch?v=${id}`,
        duration: formatYouTubeDuration(details?.contentDetails?.duration || ''),
        views: Number(details?.statistics?.viewCount || 0).toLocaleString('id-ID'),
        ago: item.snippet.publishedAt || ''
      };
    });
    return res.json({ success: true, count: data.length, data });
  } catch (err) {
    console.error('YouTube search error:', err.message);
    return res.status(504).json({ success: false, message: 'YouTube API tidak merespons tepat waktu. Coba lagi.' });
  }
});

function formatYouTubeDuration(iso) {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return '00:00';
  const h = Number(match[1] || 0), m = Number(match[2] || 0), s = Number(match[3] || 0);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// 2. Stream / Download Lagu MP3 langsung
app.get('/api/download/song', (req, res) => {
  const videoUrl = req.query.url;
  const title = req.query.title || 'lagu';

  if (!videoUrl) {
    return res.status(400).json({ error: 'URL lagu wajib disertakan' });
  }

  const filename = sanitizeFilename(title) + '.mp3';
  const encodedName = encodeURIComponent(filename);

  const tmpFile = path.join(require('os').tmpdir(), `song-${Date.now()}-${Math.random().toString(16).slice(2)}.mp3`);
  
  const cookieArgs = getCookieArgs();

  // Tambahkan --js-runtime node agar yt-dlp bisa memecahkan tantangan JavaScript YouTube
  const args = [
    ...cookieArgs,
    '--js-runtime', 'node',
    '-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0',
    '--ffmpeg-location', ffmpegPath, '--no-check-certificates', '--retries', '3', '--fragment-retries', '3',
    '-o', tmpFile, videoUrl
  ];

  const ytdlp = spawn(YTDLP_PATH, args);
  let stderr = '';
  ytdlp.stderr.on('data', data => { stderr += data.toString(); });
  ytdlp.on('error', err => {
    console.error('Download spawn error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Gagal memproses MP3' });
  });
  ytdlp.on('close', code => {
    if (code !== 0 || !fs.existsSync(tmpFile) || fs.statSync(tmpFile).size === 0) {
      console.error('yt-dlp MP3 error:', stderr.slice(-1000));
      try { fs.unlinkSync(tmpFile); } catch (_) {}
      if (!res.headersSent) res.status(502).json({ error: 'Konversi MP3 gagal, coba lagu lain.' });
      return;
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', fs.statSync(tmpFile).size);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"; filename*=UTF-8''${encodedName}`);
    const stream = fs.createReadStream(tmpFile);
    stream.pipe(res);
    stream.on('close', () => { try { fs.unlinkSync(tmpFile); } catch (_) {} });
  });
  res.on('close', () => { if (!res.writableEnded && !ytdlp.killed) ytdlp.kill(); });
});

// 2b. Stream valid MP3 preview (inline)
app.get('/api/play/song', (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) return res.status(400).json({ error: 'URL lagu wajib disertakan' });

  const tmpFile = path.join(require('os').tmpdir(), `preview-${Date.now()}-${Math.random().toString(16).slice(2)}.mp3`);
  
  const cookieArgs = getCookieArgs();

  // Tambahkan --js-runtime node di sini juga
  const args = [
    ...cookieArgs,
    '--js-runtime', 'node',
    '-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '5',
    '--ffmpeg-location', ffmpegPath, '--no-check-certificates', '--retries', '3', '--fragment-retries', '3',
    '-o', tmpFile, videoUrl
  ];

  const ytdlp = spawn(YTDLP_PATH, args);
  let stderr = '';
  ytdlp.stderr.on('data', data => { stderr += data.toString(); });
  ytdlp.on('error', err => {
    console.error('Preview spawn error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Gagal menyiapkan preview MP3' });
  });
  ytdlp.on('close', code => {
    if (code !== 0 || !fs.existsSync(tmpFile)) {
      console.error('Preview conversion error:', stderr.slice(-1000));
      try { fs.unlinkSync(tmpFile); } catch (_) {}
      if (!res.headersSent) res.status(502).json({ error: 'Gagal mengonversi audio lagu.' });
      return;
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', fs.statSync(tmpFile).size);
    res.setHeader('Accept-Ranges', 'none');
    fs.createReadStream(tmpFile).pipe(res).on('close', () => {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    });
  });
  req.on('close', () => { if (!res.writableEnded && !ytdlp.killed) ytdlp.kill(); });
});


ensureYtDlp().then(() => {
  app.listen(PORT, () => {
    console.log(`Server aktif berjalan di port ${PORT}`);
  });
}).catch(err => {
  console.error('Gagal inisialisasi yt-dlp:', err);
  process.exit(1);
});
