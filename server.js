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

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use('/clips', express.static(CLIPS_DIR));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function setupCookies() {
  const b64 = process.env.YTDLP_COOKIES_B64;
  const cookiePath = '/tmp/youtube-cookies.txt';

  if (b64) {
    try {
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      fs.writeFileSync(cookiePath, decoded, { encoding: 'utf8' });
      console.log('Cookies written from YTDLP_COOKIES_B64');
    } catch (e) {
      console.warn('Failed to write cookies:', e.message);
    }
  } else {
    const repoCookies = path.join(__dirname, 'cookies.txt');
    if (fs.existsSync(repoCookies)) {
      fs.copyFileSync(repoCookies, cookiePath);
      console.log('Cookies written from repo cookies.txt');
    } else {
      console.log('No cookies available.');
    }
  }
}

function buildYtDlpCommand(targetUrl, videoPath, format = null, limitDuration = false) {
  const cookiesFile = '/tmp/youtube-cookies.txt';

  let cmd = `yt-dlp`;
  if (format) {
    cmd += ` -f "${format}"`;
  } else {
    // Try multiple format options for better regional bypass
    cmd += ` -f "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best"`;
  }
  
  if (limitDuration) {
    // Only download the first 10 minutes (*0-600 seconds) for long videos
    cmd += ` --download-sections "*0-600"`;
  }

  cmd += ` --merge-output-format mp4`;
  cmd += ` --no-playlist`;
  cmd += ` --retries 10`;
  cmd += ` --socket-timeout 60`;
  
  // Use multiple player clients for better bypass success
  const extractorArgs = "youtube:player_client=web,default";
  cmd += ` --extractor-args "${extractorArgs}"`;
  cmd += ` --geo-bypass`;
  cmd += ` --no-check-certificates`;
  cmd += ` --sleep-requests 1`;
  cmd += ` --sleep-interval 2`;
  cmd += ` --max-sleep-interval 5`;
  
  if (fs.existsSync(cookiesFile)) {
    cmd += ` --cookies "${cookiesFile}"`;
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
      const command = buildYtDlpCommand(targetUrl, cachePath);
      await execPromise(command);
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

app.post('/generate', async (req, res) => {
  const { youtubeUrl, subtitleStyle = 'karaoke', highlightColor = '#FFD700', fontSize = 70, position = 'bottom' } = req.body;
  if (!youtubeUrl) return res.status(400).json({ error: 'YouTube URL is required' });

  const delay = Math.floor(Math.random() * 2000) + 500;
  await new Promise(resolve => setTimeout(resolve, delay));

  const jobId = uuidv4();
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
    const command = buildYtDlpCommand(targetUrl, videoPath, "best[height<=720][ext=mp4]/best[height<=720]/best", true); // Pass true to limit duration
    console.log('Command:', command);

    const ytDlpPromise = execPromise(command).then(() => {
      console.log('Download complete.');
    }).catch(error => {
      const raw = error && typeof error === 'object' && 'stderr' in error
        ? String(error.stderr)
        : error instanceof Error ? error.message : String(error);
      console.error('yt-dlp error:', raw);
      throw new Error(mapYtDlpError(raw));
    });

    let segments = [];
    let allWords = [];
    let fullText = "";

    try {
      console.log('Fetching YouTube transcript (Phase 1)...');
      const ytTranscript = await YoutubeTranscript.fetchTranscript(videoId);
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
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: `You are a viral content editor. Analyze this transcript and identify the 3 most engaging clips. For each, return: start_time, end_time, hook_description, suggested_title. Focus on: hooks, emotional peaks, surprising facts, controversial statements, humor.

Transcript:
${fullText}

Return ONLY a JSON array, no other text:
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
          
          // Ensure we extract the actual word text, handling any API differences
          const t1 = String(w1.word || w1.text || w1[0] || "").replace(/<[^>]*>/g, "").trim();
          const t2 = w2 ? String(w2.word || w2.text || w2[0] || "").replace(/<[^>]*>/g, "").trim() : "";
          
          // Apply Karaoke highlight color exactly inline
          let coloredText = `{\\c${aColor}}${t1}`;
          if (t2) {
             coloredText += ` {\\c&H00FFFFFF&}${t2}`;
          }
          
          assContent += `Dialogue: 0,${start},${end},Main,,0,0,0,,{\\b1}${coloredText.toUpperCase()}\n`;
        }
      } else {
        const secEnd = Math.floor(duration).toString().padStart(2,'0');
        assContent += `Dialogue: 0,0:00:00.00,0:00:${secEnd}.00,Main,,0,0,0,,{\\b1}{\\c${aColor}}${(moment.subtitle || moment.title).toUpperCase()}\n`;
      }

      console.log('ASS SAMPLE:', assContent.substring(0, 500));

      fs.writeFileSync(assPath, assContent, { encoding: 'utf8' });
      const escapedAssPath = assPath.replace(/\\/g, '/').replace(/:/g, '\\\\:');

      try {
        console.log(`Generating clip: ${moment.title} (${duration.toFixed(1)}s)`);
        await run(`ffmpeg -hide_banner -loglevel error -threads 1 -ss ${moment.start} -i "${videoPath}" -t ${duration} -vf "crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=720:-2,ass='${escapedAssPath}'" -c:a aac -b:a 128k -c:v libx264 -preset ultrafast -crf 23 -y "${clipPath}"`);
        
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
    res.json({ clips });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.toString() });
  }
});

const PORT = process.env.PORT || 8000;
setupCookies();
run('yt-dlp --version').then(v => console.log('yt-dlp version:', v.trim())).catch(() => {});
app.listen(PORT, () => console.log(`Trueclip backend running on port ${PORT}`));
