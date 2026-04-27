const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');
const { v4: uuidv4 } = require('uuid');
const execPromise = util.promisify(exec);

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use('/clips', express.static('/tmp/clips'));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Decode and write cookies from env on startup ────────────────────────────
function setupCookies() {
  const b64 = process.env.YTDLP_COOKIES_B64;
  const cookiePath = process.env.YTDLP_COOKIES_FILE || '/tmp/youtube-cookies.txt';

  if (b64) {
    try {
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      fs.writeFileSync(cookiePath, decoded, { encoding: 'utf8' });
      console.log(`Cookies written to ${cookiePath} (from env)`);
    } catch (e) {
      console.warn('Failed to write cookies from YTDLP_COOKIES_B64:', e.message);
    }
  } else {
    // Fallback: copy cookies.txt bundled in the repo
    const repoCookies = path.join(__dirname, 'cookies.txt');
    if (fs.existsSync(repoCookies)) {
      try {
        fs.copyFileSync(repoCookies, cookiePath);
        console.log(`Cookies written to ${cookiePath} (from repo cookies.txt)`);
      } catch (e) {
        console.warn('Failed to copy repo cookies.txt:', e.message);
      }
    } else {
      console.log('No cookies available — running without cookies.');
    }
  }
}

// ─── Build yt-dlp command with all env-driven flags ──────────────────────────
function buildYtDlpCommand(targetUrl, videoPath) {
  const jsRuntime     = process.env.YTDLP_JS_RUNTIMES    || 'node';
  const extractorArgs = process.env.YTDLP_EXTRACTOR_ARGS;
  const cookiesFile   = process.env.YTDLP_COOKIES_FILE   || '/tmp/youtube-cookies.txt';

  let cmd = `yt-dlp`;
  cmd += ` -f "best[ext=mp4]/best"`;
  cmd += ` --merge-output-format mp4`;
  cmd += ` --no-playlist`;
  cmd += ` --retries 5`;
  cmd += ` --socket-timeout 30`;
  cmd += ` --js-runtimes "${jsRuntime}"`;

  if (extractorArgs) {
    cmd += ` --extractor-args "${extractorArgs}"`;
  }

  if (fs.existsSync(cookiesFile)) {
    cmd += ` --cookies "${cookiesFile}"`;
  }

  cmd += ` -o "${videoPath}"`;
  cmd += ` "${targetUrl}"`;

  return cmd;
}

// ─── Map yt-dlp stderr to user-friendly messages ─────────────────────────────
function mapYtDlpError(stderr) {
  if (!stderr) return 'Unknown yt-dlp error.';
  const s = stderr.toLowerCase();

  if (s.includes('no supported javascript runtime could be found')) {
    return 'yt-dlp needs a JavaScript runtime. Make sure YTDLP_JS_RUNTIMES=node is set and Node is available.';
  }
  if (s.includes('sign in to confirm') || s.includes('not a bot') || s.includes('cookie')) {
    return 'YouTube is blocking this request. Export authenticated cookies and set YTDLP_COOKIES_B64 in Railway.';
  }
  if (s.includes('private video')) {
    return 'This video is private and cannot be downloaded.';
  }
  if (s.includes('members only') || s.includes('membership')) {
    return 'This video is for channel members only.';
  }
  if (s.includes('age') && s.includes('restrict')) {
    return 'This video is age-restricted. Authenticated cookies may help.';
  }
  if (s.includes('video unavailable') || s.includes('has been removed')) {
    return 'This video is unavailable or has been removed from YouTube.';
  }
  if (s.includes('geo') || s.includes('not available in your country')) {
    return 'This video is geo-blocked in the server region.';
  }

  return stderr.slice(-500).trim();
}

async function updateYtDlp() {
  try {
    const version = await run('yt-dlp --version');
    console.log('yt-dlp version:', version.trim());
  } catch(e) {
    console.log('yt-dlp version check failed:', e);
  }
}

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 100 }, (err, stdout, stderr) => {
      if (err) reject(stderr || err.message);
      else resolve(stdout);
    });
  });
}

app.get('/', (req, res) => res.json({ status: 'Trueclip backend running' }));

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const http = require('http');
    const protocol = url.startsWith('https') ? https : http;

    const file = fs.createWriteStream(destPath);
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.youtube.com/',
        'Origin': 'https://www.youtube.com'
      }
    };

    function doRequest(reqUrl) {
      protocol.get(reqUrl, options, (response) => {
        if ([301, 302, 303].includes(response.statusCode)) {
          doRequest(response.headers.location);
          return;
        }
        if (response.statusCode !== 200) {
          reject(new Error(`Download failed: ${response.statusCode}`));
          return;
        }
        response.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }).on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    }
    doRequest(url);
  });
}

app.post('/generate', async (req, res) => {
  const { youtubeUrl } = req.body;

  if (!youtubeUrl) {
    return res.status(400).json({ error: 'YouTube URL is required' });
  }

  const delay = Math.floor(Math.random() * 3000) + 1000;
  await new Promise(resolve => setTimeout(resolve, delay));

  const jobId = uuidv4();
  const tmpDir = `/tmp/${jobId}`;
  const clipsDir = `/tmp/clips/${jobId}`;

  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.mkdirSync(clipsDir, { recursive: true });

    const videoId = youtubeUrl.match(/(?:v=|youtu\.be\/)([^&\n?#]+)/)?.[1];
    if (!videoId) throw new Error('Invalid YouTube URL — could not extract video ID.');

    const targetUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const videoPath = `${tmpDir}/video.mp4`;

    console.log(`Downloading: ${targetUrl}`);
    const command = buildYtDlpCommand(targetUrl, videoPath);
    console.log('yt-dlp command:', command);

    try {
      const { stderr } = await execPromise(command);
      if (stderr && !stderr.includes('100%')) {
        console.log('yt-dlp logs:', stderr);
      }
      console.log('Download complete.');
    } catch (error) {
      const rawStderr =
        error && typeof error === 'object' && 'stderr' in error
          ? String(error.stderr)
          : error instanceof Error ? error.message : String(error);

      const friendlyMessage = mapYtDlpError(rawStderr);
      console.error('yt-dlp failed:', rawStderr);
      return res.status(500).json({ error: `Failed to download video: ${friendlyMessage}` });
    }

    console.log('Extracting audio...');
    const audioPath = `${tmpDir}/audio.mp3`;
    await run(`ffmpeg -hide_banner -loglevel error -i "${videoPath}" -q:a 2 -map a "${audioPath}" -y`);

    console.log('Transcribing...');
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: 'whisper-1',
      response_format: 'verbose_json',
      timestamp_granularities: ['segment']
    });

    const segments = transcription.segments;
    const fullText = segments.map(s => `[${s.start.toFixed(1)}s-${s.end.toFixed(1)}s]: ${s.text}`).join('\n');

    console.log('Finding best moments...');
    const gptResponse = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: `You are a viral video editor. Given this video transcript with timestamps, find the 5 most engaging, funny, or interesting moments that would make great 30-60 second shorts for TikTok/YouTube Shorts.

Transcript:
${fullText}

Return ONLY a JSON array like this, no other text:
[
  { "start": 10.5, "end": 45.2, "title": "Funny moment title", "subtitle": "Short description of what happens" },
  { "start": 120.0, "end": 165.0, "title": "Interesting insight", "subtitle": "Short description" }
]

Rules:
- Each clip must be 25-60 seconds long
- Pick genuinely interesting/funny/viral moments
- Return exactly 5 clips
- Only return the JSON array, nothing else`
      }],
      temperature: 0.7
    });

    let moments;
    try {
      const raw = gptResponse.choices[0].message.content.trim();
      const cleaned = raw.replace(/```json|```/g, '').trim();
      moments = JSON.parse(cleaned);
    } catch {
      return res.status(500).json({ error: 'Failed to parse AI response' });
    }

    console.log('Cutting clips...');
    const clips = [];

    for (let i = 0; i < moments.length; i++) {
      const moment = moments[i];
      const clipId = uuidv4();
      const clipPath = `${clipsDir}/${clipId}.mp4`;
      const duration = moment.end - moment.start;

      const srtPath = `${tmpDir}/${clipId}.srt`;
      const srtContent = `1\n00:00:00,000 --> 00:00:${Math.floor(duration).toString().padStart(2, '0')},000\n${moment.subtitle}\n`;
      fs.writeFileSync(srtPath, srtContent);

      await run(`ffmpeg -hide_banner -loglevel error -ss ${moment.start} -i "${videoPath}" -t ${duration} -vf "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,subtitles='${srtPath}':force_style='FontSize=14,PrimaryColour=&HFFFFFF,OutlineColour=&H000000,Bold=1'" -c:v libx264 -c:a aac -preset ultrafast -crf 28 -maxrate 1M -bufsize 2M "${clipPath}" -y`);

      clips.push({
        id: clipId,
        videoUrl: `${process.env.BACKEND_URL}/clips/${jobId}/${clipId}.mp4`,
        duration: Math.round(duration),
        title: moment.title,
        subtitle: moment.subtitle,
        startTime: moment.start,
        endTime: moment.end
      });
    }

    console.log('Done!');
    res.json({ clips });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.toString() });
  }
});

const PORT = process.env.PORT || 8000;
setupCookies();
updateYtDlp();
app.listen(PORT, () => console.log(`Trueclip backend running on port ${PORT}`));