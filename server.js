const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');
const { v4: uuidv4 } = require('uuid');
const { YoutubeTranscript } = require('youtube-transcript');
const execPromise = util.promisify(exec);
const VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_CACHE_DIR = '/tmp/youtube-cache';
const CLIPS_DIR = '/tmp/clips';
const clipIndex = new Map();
const jobs = {};

const app = express();
app.use(cors({ origin: 'https://trueclip.vercel.app' }));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use('/clips', express.static(CLIPS_DIR));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const DEFAULT_YT_FORMAT = 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best';
const FALLBACK_YT_FORMAT = 'bestvideo+bestaudio/best';
const DEFAULT_YT_EXTRACTOR_ARGS = 'youtube:player_client=android,mweb,web,default';

function setupCookies() {
  const cookiePath = '/tmp/youtube-cookies.txt';
  const cookieFile = process.env.YTDLP_COOKIES_FILE?.trim();
  const b64 = process.env.YTDLP_COOKIES_B64;

  if (cookieFile) {
    try {
      const resolvedCookieFile = path.resolve(cookieFile);
      if (fs.existsSync(resolvedCookieFile)) {
        fs.copyFileSync(resolvedCookieFile, cookiePath);
        console.log('Cookies written from YTDLP_COOKIES_FILE');
        return;
      }
      console.warn('YTDLP_COOKIES_FILE was set but the file was not found:', resolvedCookieFile);
    } catch (e) {
      console.warn('Failed to write cookies from YTDLP_COOKIES_FILE:', e.message);
    }
  }

  if (b64) {
    try {
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      fs.writeFileSync(cookiePath, decoded, { encoding: 'utf8' });
      console.log('Cookies written from YTDLP_COOKIES_B64');
      return;
    } catch (e) {
      console.warn('Failed to write cookies:', e.message);
    }
  }

  const repoCookies = path.join(__dirname, 'cookies.txt');
  if (fs.existsSync(repoCookies)) {
    fs.copyFileSync(repoCookies, cookiePath);
    console.log('Cookies written from repo cookies.txt');
  } else {
    console.log('No cookies available.');
  }
}

function buildYtDlpCommand(targetUrl, videoPath, options = {}) {
  const {
    format = DEFAULT_YT_FORMAT,
    limitDuration = false,
    extractorArgs = process.env.YTDLP_EXTRACTOR_ARGS?.trim() || DEFAULT_YT_EXTRACTOR_ARGS,
  } = options;
  const cookiesFile = '/tmp/youtube-cookies.txt';

  let cmd = `yt-dlp`;
  if (format) {
    cmd += ` -f "${format}"`;
  }
  
  if (limitDuration) {
    // Only download the first 10 minutes (*0-600 seconds) for long videos
    cmd += ` --download-sections "*0-600"`;
  }

  cmd += ` --merge-output-format mp4`;
  cmd += ` --no-playlist`;
  cmd += ` --retries 10`;
  cmd += ` --socket-timeout 60`;
  
  if (extractorArgs) {
    cmd += ` --extractor-args "${extractorArgs}"`;
  }
  cmd += ` --geo-bypass`;
  cmd += ` --no-check-certificates`;
  cmd += ` --sleep-requests 1`;
  cmd += ` --sleep-interval 2`;
  cmd += ` --max-sleep-interval 5`;
  
  if (fs.existsSync(cookiesFile)) {
    cmd += ` --cookies "${cookiesFile}"`;
  }

  const cookiesFromBrowser = process.env.YTDLP_COOKIES_FROM_BROWSER?.trim();
  if (!fs.existsSync(cookiesFile) && cookiesFromBrowser) {
    cmd += ` --cookies-from-browser "${cookiesFromBrowser}"`;
  }

  const runtimes = process.env.YTDLP_JS_RUNTIMES || "node";
  cmd += ` --js-runtimes "${runtimes}"`;

  const proxy = process.env.YTDLP_PROXY;
  if (proxy) {
    cmd += ` --proxy "${proxy}"`;
  }

  cmd += ` -o "${videoPath}"`;
  cmd += ` "${targetUrl}"`;

  return cmd;
}

function getYtDlpCommandAttempts(limitDuration = false) {
  const baseExtractorArgs = process.env.YTDLP_EXTRACTOR_ARGS?.trim() || DEFAULT_YT_EXTRACTOR_ARGS;
  const extractorArgsAttempts = [
    baseExtractorArgs,
    'youtube:player_client=android,mweb,web,default',
    'youtube:player_client=android,web',
    'youtube:player_client=web,default',
  ].filter((value, index, array) => Boolean(value) && array.indexOf(value) === index);

  const formatAttempts = [DEFAULT_YT_FORMAT, 'bv*[height<=1080]+ba/b[height<=1080]/b', FALLBACK_YT_FORMAT];

  return extractorArgsAttempts.flatMap((extractorArgs) => (
    formatAttempts.map((format) => ({
      extractorArgs,
      format,
      limitDuration,
    }))
  ));
}

function getYtDlpErrorMessage(error) {
  const raw = error && typeof error === 'object' && 'stderr' in error
    ? String(error.stderr)
    : error instanceof Error ? error.message : String(error);
  return mapYtDlpError(raw);
}

async function downloadWithFallback(targetUrl, videoPath, limitDuration = false) {
  const attempts = getYtDlpCommandAttempts(limitDuration);
  let lastError = null;

  for (const [index, attempt] of attempts.entries()) {
    const command = buildYtDlpCommand(targetUrl, videoPath, attempt);
    console.log(`yt-dlp attempt ${index + 1}/${attempts.length}`);
    try {
      await execPromise(command);
      return;
    } catch (error) {
      lastError = error;
      const message = getYtDlpErrorMessage(error);
      console.warn(`yt-dlp attempt ${index + 1} failed:`, message);
    }
  }

  throw new Error(getYtDlpErrorMessage(lastError));
}

function isValidVideoId(videoId) {
  return typeof videoId === 'string' && VIDEO_ID_REGEX.test(videoId);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function registerClip(jobId, clipId, clipPath) {
  if (!clipIndex.has(jobId)) {
    clipIndex.set(jobId, new Map());
  }

  clipIndex.get(jobId).set(clipId, clipPath);
}

function resolveClipPath(jobId, clipId) {
  const jobMap = clipIndex.get(jobId);
  const mappedPath = jobMap ? jobMap.get(clipId) : null;
  if (mappedPath && fs.existsSync(mappedPath)) {
    return mappedPath;
  }

  const fallbackPath = path.join(CLIPS_DIR, jobId, `${clipId}.mp4`);
  if (fs.existsSync(fallbackPath)) {
    return fallbackPath;
  }

  return null;
}

function sanitizeFilename(rawTitle, fallback) {
  const cleaned = String(rawTitle || '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .substring(0, 80);

  return cleaned || fallback;
}

function mapYtDlpError(stderr) {
  if (!stderr) return 'Unknown yt-dlp error.';
  const s = stderr.toLowerCase();
  if (s.includes('no supported javascript runtime')) return 'yt-dlp JS runtime missing.';
  if (s.includes('sign in') || s.includes('not a bot') || s.includes('cookie') || s.includes('no longer valid')) return 'YouTube is blocking this request — cookies may be expired.';
  if (s.includes('private video')) return 'This video is private.';
  if (s.includes('members only')) return 'This video is for channel members only.';
  if (s.includes('age') && s.includes('restrict')) return 'This video is age-restricted.';
  if (s.includes('video unavailable') || s.includes('has been removed')) return 'This video is unavailable.';
  if (s.includes('geo') || s.includes('not available in your country')) return 'This video is geo-blocked.';
  return stderr.slice(-800).trim();
}

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
      if (err) reject(stderr || err.message);
      else resolve(stdout);
    });
  });
}

app.get('/', (req, res) => res.json({ status: 'Trueclip backend running' }));

app.get('/job-status/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const job = jobs[jobId];
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  res.json({ status: job.status, clips: job.clips, message: job.message });
});

app.get('/download/youtube/:videoId', async (req, res) => {
  const videoId = req.params.videoId;
  const title = req.query.title || '';

  if (!isValidVideoId(videoId)) {
    return res.status(400).json({ error: 'Invalid video ID.' });
  }

  ensureDir(YOUTUBE_CACHE_DIR);
  const cachePath = path.join(YOUTUBE_CACHE_DIR, `${videoId}.mp4`);

  try {
    if (!fs.existsSync(cachePath)) {
      const targetUrl = `https://www.youtube.com/watch?v=${videoId}`;
      await downloadWithFallback(targetUrl, cachePath);
    }

    const fileName = `${sanitizeFilename(title, videoId)}.mp4`;

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    const stream = fs.createReadStream(cachePath);
    stream.on('error', () => {
      res.status(500).end();
    });

    stream.pipe(res);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Download failed.';
    res.status(500).json({ error: message });
  }
});

app.get('/download/:jobId/:clipId', (req, res) => {
  const jobId = path.basename(req.params.jobId || '');
  const clipIdRaw = path.basename(req.params.clipId || '');

  if (!jobId || !clipIdRaw) {
    return res.status(400).json({ error: 'Missing clip identifier.' });
  }

  const clipId = clipIdRaw.replace(/\.mp4$/i, '');
  const clipPath = resolveClipPath(jobId, clipId);

  if (!clipPath) {
    return res.status(404).json({ error: 'Clip file was not found. Please regenerate the clip.' });
  }

  const safeName = `trueclip-${clipId}.mp4`;

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);

  const stream = fs.createReadStream(clipPath);
  stream.on('error', () => {
    res.status(500).end();
  });

  stream.pipe(res);
});

app.get('/tiktok/creator-info', async (req, res) => {
  const { access_token } = req.query;
  const response = await fetch('https://open.tiktokapis.com/v2/post/publish/creator_info/query/', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${access_token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({})
  });
  const data = await response.json();
  
  if (data.error) return res.status(400).json({ error: data.error });
  
  res.json({
    privacy_level_options: data.data.privacy_level_options,
    max_video_post_duration_sec: data.data.max_video_post_duration_sec,
    comment_disabled: data.data.comment_disabled,
    duet_disabled: data.data.duet_disabled,
    stitch_disabled: data.data.stitch_disabled
  });
});

const TIKTOK_REPOST_URL = "https://open.tiktokapis.com/v2/post/publish/video/init/";

app.post('/tiktok/repost', async (req, res) => {
  try {
    const { 
      access_token, 
      video_url, 
      title = "My latest short is live",
      privacy_level,
      allow_comment = false,
      allow_duet = false,
      allow_stitch = false,
      commercial_content_toggle = false,
      your_brand = false,
      branded_content = false
    } = req.body;

    if (!access_token || !video_url) {
      return res.status(400).json({ error: "access_token and video_url are required." });
    }

    if (!privacy_level) {
      return res.status(400).json({ error: "privacy_level is required." });
    }

    let buffer;
    
    // Check if the URL points to our backend itself or a local file
    // Example: http://localhost:8000/clips/jobId/clipId.mp4
    if (video_url.includes('/clips/')) {
      try {
        const parts = new URL(video_url).pathname.split('/');
        const jobId = parts[parts.length - 2];
        const clipIdRaw = parts[parts.length - 1];
        const clipId = clipIdRaw.replace(/\.mp4$/i, '');
        const clipPath = resolveClipPath(jobId, clipId);
        if (clipPath) {
          buffer = fs.readFileSync(clipPath);
        }
      } catch (e) {
        console.warn("Failed to read local clip matching video_url, falling back to fetch", e.message);
      }
    }

    if (!buffer) {
      const videoResponse = await fetch(video_url);
      if (!videoResponse.ok) {
        return res.status(400).json({ error: `Failed to download video: ${videoResponse.statusText}` });
      }
      const arrayBuffer = await videoResponse.arrayBuffer();
      buffer = Buffer.from(arrayBuffer);
    }

    const videoSize = buffer.length;
    const maxChunkSize = 64 * 1024 * 1024; // 64 MB
    let chunkSize = videoSize;
    let totalChunkCount = 1;

    if (videoSize > maxChunkSize) {
      chunkSize = maxChunkSize;
      totalChunkCount = Math.ceil(videoSize / chunkSize);
    }

    const repostPayload = {
      post_info: {
        title,
        privacy_level: privacy_level,
        disable_duet: !allow_duet,
        disable_comment: !allow_comment,
        disable_stitch: !allow_stitch,
        brand_organic_toggle: your_brand,
        brand_content_toggle: branded_content,
      },
      source_info: {
        source: "FILE_UPLOAD",
        video_size: videoSize,
        chunk_size: chunkSize,
        total_chunk_count: totalChunkCount,
      },
    };

    const initResponse = await fetch(TIKTOK_REPOST_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(repostPayload),
    });

    const payload = await initResponse.json().catch(() => null);

    if (!initResponse.ok) {
      const errorMessage =
        payload?.error?.message ||
        payload?.message ||
        payload?.error_description ||
        "Unable to repost video to TikTok.";
      return res.status(initResponse.status).json({ error: errorMessage });
    }

    const publishId = payload?.data?.publish_id || payload?.publish_id || "";
    const uploadUrl = payload?.data?.upload_url || payload?.upload_url || "";

    if (!publishId || !uploadUrl) {
      return res.status(500).json({ error: "TikTok returned valid init response but missing publish_id or upload_url." });
    }

    // Upload chunks to the uploadUrl directly
    for (let i = 0; i < totalChunkCount; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, videoSize);
      const chunk = buffer.subarray(start, end);
      const contentRange = `bytes ${start}-${end - 1}/${videoSize}`;

      const uploadRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": chunk.length.toString(),
          "Content-Range": contentRange,
        },
        body: chunk,
      });

      if (!uploadRes.ok) {
        let uploadErrText = uploadRes.statusText;
        try {
            uploadErrText = await uploadRes.text();
        } catch(e){}
        return res.status(500).json({ error: `Failed to upload chunk ${i + 1} to TikTok: ${uploadRes.status} ${uploadErrText}` });
      }
    }

    return res.json({
      success: true,
      publish_id: publishId,
    });
  } catch (error) {
    console.error("TikTok Repost Error:", error);
    return res.status(500).json({ error: "Unable to repost video to TikTok. " + (error.message || "") });
  }
});

app.post(['/generate-clips', '/generate'], async (req, res) => {
  const { youtubeUrl, subtitleStyle = 'karaoke', highlightColor = '#FFD700', fontSize = 70, position = 'bottom' } = req.body;
  if (!youtubeUrl) return res.status(400).json({ error: 'YouTube URL is required' });

  const jobId = uuidv4();
  jobs[jobId] = { status: 'processing' };
  
  // Return early for async processing
  res.json({ jobId });

  // Process asynchronously in the background
  (async () => {
    const tmpDir = `/tmp/${jobId}`;
    const clipsDir = path.join(CLIPS_DIR, jobId);

    try {
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.mkdirSync(clipsDir, { recursive: true });

      const videoId = youtubeUrl.match(/(?:v=|youtu\.be\/)([^&\n?#]+)/)?.[1];
      if (!videoId) throw new Error('Invalid YouTube URL.');

    const targetUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const videoPath = `${tmpDir}/video.mp4`;

    console.log(`Downloading: ${targetUrl}`);
    const ytDlpPromise = downloadWithFallback(targetUrl, videoPath, true).then(() => {
      console.log('Download complete.');
    }).catch(error => {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('yt-dlp error:', raw);
      throw new Error(mapYtDlpError(raw));
    });

    let segments = [];
    let allWords = [];
    let fullText = "";

    try {
      console.log('Fetching YouTube transcript (Phase 1)...');
      let ytTranscript;
      try {
        ytTranscript = await YoutubeTranscript.fetchTranscript(videoId, { lang: 'en' });
      } catch {
        try {
          ytTranscript = await YoutubeTranscript.fetchTranscript(videoId, { lang: 'a.en' });
        } catch {
          ytTranscript = await YoutubeTranscript.fetchTranscript(videoId);
          const joinedText = ytTranscript.map(t => t.text).join(' ');
          if (/[^\x00-\x7F]/.test(joinedText)) {
            console.log('Foreign language detected, translating transcript with OpenAI...');
            const transResponse = await openai.chat.completions.create({
              model: 'gpt-5.4-mini',
              messages: [{
                role: 'system',
                content: 'Translate the "text" fields in this JSON array to English. Do not change offset or duration. Output ONLY the strict JSON array without markdown.'
              }, {
                role: 'user',
                content: JSON.stringify(ytTranscript.map(t => ({ offset: t.offset, duration: t.duration, text: t.text })))
              }],
              temperature: 0.3
            });
            const transRaw = transResponse.choices[0].message.content.trim();
            const translatedArr = JSON.parse(transRaw.replace(/```json|```/g, '').trim());
            // Ensure we keep the exact track format
            ytTranscript = translatedArr.map(t => ({ offset: t.offset, duration: t.duration, text: t.text }));
          }
        }
      }
      
      console.log('YouTube captions found. Converting to word-level format...');
      ytTranscript.forEach((track) => {
        const sStart = track.offset / 1000;
        const sDur = track.duration / 1000;
        segments.push({ start: sStart, end: sStart + sDur, text: track.text });

        const wArr = track.text.split(' ');
        const wDur = sDur / (wArr.length || 1);
        wArr.forEach((w, wIndex) => {
          allWords.push({ word: w, start: sStart + (wIndex * wDur), end: sStart + ((wIndex + 1) * wDur) });
        });
      });
      segments = segments.filter(s => s.start <= 600); // Exclude segments past 10 minutes to sync with yt-dlp limit
      fullText = segments.map(s => `[${s.start.toFixed(1)}s-${s.end.toFixed(1)}s]: ${s.text}`).join('\n');
    } catch (ytErr) {
      console.log('YouTube captions unavailable. Waiting for video download to fallback to OpenAI Whisper...');
      await ytDlpPromise; // Need the video to extract audio
      console.log('Extracting audio for Whisper...');
      const audioPath = `${tmpDir}/audio.mp3`;
      await run(`ffmpeg -hide_banner -loglevel error -i "${videoPath}" -vn -c:a libmp3lame -b:a 64k -ac 1 "${audioPath}" -y`);
      console.log('Transcribing...');
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(audioPath),
        model: 'whisper-1',
        language: 'en',
        response_format: 'verbose_json',
        timestamp_granularities: ['word', 'segment']
      });

      segments = transcription.segments || [];
      allWords = transcription.words || [];
      fullText = segments.map(s => `[${s.start.toFixed(1)}s-${s.end.toFixed(1)}s]: ${s.text}`).join('\n');
    }

    // Ensure download finishes before attempting to cut clips, even if we had YouTube captions.
    await ytDlpPromise;
    console.log('Cleaning up audio path...');
    try { if (fs.existsSync(`${tmpDir}/audio.mp3`)) fs.unlinkSync(`${tmpDir}/audio.mp3`); } catch(e) {}

    console.log('Finding best moments...');
    const gptResponse = await openai.chat.completions.create({
      model: 'gpt-5.4-mini',
      messages: [{
        role: 'user',
        content: `You are a viral content editor. Analyze this transcript and identify the 3 most engaging clips. Focus on: hooks, emotional peaks, surprising facts, controversial statements, humor.

Transcript:
${fullText}

Return ONLY a JSON array, no other text. Use EXACTLY these keys: "start", "end", "title", "subtitle":
[
  { "start": 10.5, "end": 45.2, "title": "Suggested Title", "subtitle": "Hook description" }
]
Rules: each clip MUST be between 30 and 45 seconds maximum. Return exactly 3 clips, only the JSON array. Even if the video is unengaging or boring, you MUST return at least 3 clips. Do not apply a strict threshold, just pick the best available parts.`
      }],
      temperature: 0.7
    });

    let moments = [];
    try {
      const raw = gptResponse.choices[0].message.content.trim();
      let parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
      
      if (Array.isArray(parsed)) {
        moments = parsed;
      } else if (parsed && Array.isArray(parsed.clips)) {
        moments = parsed.clips;
      } else if (parsed && typeof parsed === 'object') {
        const firstValue = Object.values(parsed)[0];
        if (Array.isArray(firstValue)) {
          moments = firstValue;
        }
      }
    } catch {
      console.log('Failed to parse AI response, falling back to equal segments...');
    }

    // Normalize keys just in case the model used different ones
    if (moments && moments.length > 0) {
      moments = moments.map(m => ({
        start: Number(m.start ?? m.start_time ?? 0),
        end: Number(m.end ?? m.end_time ?? 30),
        title: m.title ?? m.suggested_title ?? 'Clip',
        subtitle: m.subtitle ?? m.hook_description ?? 'Hook'
      }));
    }

    if (!moments || moments.length === 0) {
      console.log('No strong moments found, falling back to equal segments...');
      const videoDuration = segments[segments.length - 1]?.end || 60;
      moments = [];
      const clipLength = 45;
      for (let i = 0; i < videoDuration; i += clipLength) {
        if (i + 15 > videoDuration) break; // skip trailing small clip
        moments.push({
          start: i,
          end: Math.min(i + clipLength, videoDuration),
          title: `Segment ${Math.floor(i / clipLength) + 1}`,
          subtitle: "Segment"
        });
        if (moments.length === 3) break;
      }
      if (moments.length === 0) {
         moments.push({
            start: 0,
            end: Math.min(30, videoDuration),
            title: "First Segment",
            subtitle: "Segment"
         });
      }
    }

    console.log('Cutting clips sequentially...');
    
    const backendUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 8000}`;
    
    const clips = [];
    for (const moment of moments) {
      const clipId = uuidv4();
      const clipPath = `${clipsDir}/${clipId}.mp4`;
      
      // Enforce 45s hard cap logic
      let endMoment = moment.end;
      if (endMoment - moment.start > 45) {
        endMoment = moment.start + 45;
      }
      const duration = endMoment - moment.start;
      
      const assPath = `${tmpDir}/${clipId}.ass`;

      function hexToAssColor(hex) {
        if (!hex) return "&H00D7FF&"; // default matching #FFD700 roughly
        const h = hex.replace('#', '');
        if (h.length === 6) {
          return `&H00${h.substring(4,6)}${h.substring(2,4)}${h.substring(0,2)}&`; // BGR format
        }
        return "&H00D7FF&";
      }
      
      const aColor = hexToAssColor(highlightColor);
      const fSize = parseInt(fontSize) || 70;
      const margV = position === 'top' ? 200 : 400;

      console.log('TRANSCRIPT SAMPLE:', JSON.stringify(allWords.slice(0, 5)));

      let styleDef = "";
      if (subtitleStyle === 'clean') {
        styleDef = `Style: Main,Arial Black,${fSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,0,2,20,20,${margV},1`;
      } else if (subtitleStyle === 'background') {
        styleDef = `Style: Main,Arial Black,${fSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,3,4,0,2,20,20,${margV},1`;
      } else if (subtitleStyle === 'neon') {
        styleDef = `Style: Main,Arial Black,${fSize},&HFFD900&,&H00FFFFFF,&H00FFFFFF,&H80D900&,-1,0,0,0,100,100,0,0,1,4,2,2,20,20,${margV},1`;
      } else if (subtitleStyle === 'outline') {
        styleDef = `Style: Main,Impact,${fSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,7,0,2,20,20,${margV},1`;
      } else {
        styleDef = `Style: Main,Arial Black,${fSize},${aColor},&H00888888,&H00000000,&H80000000,-1,0,0,0,105,105,1,0,1,5,2,2,20,20,${margV},1`;
      }
      
      let assContent = `\ufeff[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styleDef}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

      const formatAssTime = (seconds) => {
        const secs = Math.max(0, seconds);
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60).toString().padStart(2, '0');
        const s = Math.floor(secs % 60).toString().padStart(2, '0');
        const cs = Math.floor((secs % 1) * 100).toString().padStart(2, '0');
        return `${h}:${m}:${s}.${cs}`;
      };

      const clipWords = allWords.filter(w => w.start >= moment.start && w.end <= endMoment);
      
      if (clipWords.length > 0) {
        for (let i = 0; i < clipWords.length; i += 2) {
          const w1 = clipWords[i];
          const w2 = clipWords[i+1];
          const start = formatAssTime(w1.start - moment.start);
          const end = formatAssTime((w2 ? w2.end : w1.end) - moment.start);
          
          const safeWord1 = String(w1.word || w1.text || w1[0] || '').replace(/<[^>]*>/g, '').trim();
          if (!safeWord1 || !isNaN(Number(safeWord1))) continue;

          let safeWord2 = '';
          if (w2) {
             const t2 = String(w2.word || w2.text || w2[0] || '').replace(/<[^>]*>/g, '').trim();
             if (t2 && isNaN(Number(t2))) safeWord2 = t2;
          }
          
          let coloredText = `{\\c${aColor}}${safeWord1}`;
          if (safeWord2) {
             coloredText += ` {\\c&H00FFFFFF&}${safeWord2}`;
          }
          
          assContent += `Dialogue: 0,${start},${end},Main,,0,0,0,,{\\b1}${coloredText.toUpperCase()}\n`;
        }
      } else {
        const secEnd = Math.floor(duration).toString().padStart(2,'0');
        const fallbackText = String(moment.subtitle || moment.title || 'CLIP');
        assContent += `Dialogue: 0,0:00:00.00,0:00:${secEnd}.00,Main,,0,0,0,,{\\b1}{\\c${aColor}}${fallbackText.toUpperCase()}\n`;
      }

      console.log('ASS SAMPLE:', assContent.substring(0, 500));

      fs.writeFileSync(assPath, assContent, { encoding: 'utf8' });
      const escapedAssPath = assPath.replace(/\\/g, '/').replace(/:/g, '\\\\:');

      try {
        console.log(`Generating clip: ${moment.title} (${duration.toFixed(1)}s) at 1080p resolution`);
        await run(`ffmpeg -hide_banner -loglevel error -threads 1 -ss ${moment.start} -i "${videoPath}" -t ${duration} -vf "crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:-2,ass='${escapedAssPath}'" -c:a aac -b:a 192k -c:v libx264 -preset fast -crf 18 -y "${clipPath}"`);
        
        registerClip(jobId, clipId, clipPath);

        clips.push({
          id: clipId,
          videoUrl: `${backendUrl}/clips/${jobId}/${clipId}.mp4`,
          downloadUrl: `${backendUrl}/download/${jobId}/${clipId}.mp4`,
          duration: Math.round(duration),
          title: moment.title || 'Clip',
          subtitle: moment.subtitle,
          startTime: moment.start,
          endTime: endMoment
        });
      } catch (err) {
        console.error(`Failed to generate clip ${clipId}:`, err.message || err);
      } finally {
        try { if (fs.existsSync(assPath)) fs.unlinkSync(assPath); } catch(e) {}
      }
    }

    try { if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath); } catch(e) {}

    console.log('Done generating all clips!');
    jobs[jobId] = { status: 'done', clips: clips };
    console.log('Job marked done:', jobId, clips.length, 'clips');

  } catch (error) {
    console.error('Error:', error);
    jobs[jobId] = { status: 'error', message: error.toString() };
  }
})();
});

const PORT = process.env.PORT || 8000;
setupCookies();
run('yt-dlp --version').then(v => console.log('yt-dlp version:', v.trim())).catch(() => {});
app.listen(PORT, () => console.log(`Trueclip backend running on port ${PORT}`));
