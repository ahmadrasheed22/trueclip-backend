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

function buildYtDlpCommand(targetUrl, videoPath) {
  const cookiesFile = '/tmp/youtube-cookies.txt';

  let cmd = `yt-dlp`;
  cmd += ` -f "best[height<=720][ext=mp4]/best[height<=720]/best"`;
  cmd += ` --merge-output-format mp4`;
  cmd += ` --no-playlist`;
  cmd += ` --retries 10`;
  cmd += ` --socket-timeout 60`;
  
  // Bypass bot/captcha using heavily reduced web client and strict auth parameters rather than full aggressive scraping
  const extractorArgs = "youtube:player_client=default";
  cmd += ` --extractor-args "${extractorArgs}"`;
  cmd += ` --geo-bypass`;
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
    exec(cmd, { maxBuffer: 1024 * 1024 * 100 }, (err, stdout, stderr) => {
      if (err) reject(stderr || err.message);
      else resolve(stdout);
    });
  });
}

app.get('/', (req, res) => res.json({ status: 'Trueclip backend running' }));

app.post('/generate', async (req, res) => {
  const { youtubeUrl } = req.body;
  if (!youtubeUrl) return res.status(400).json({ error: 'YouTube URL is required' });

  const delay = Math.floor(Math.random() * 2000) + 500;
  await new Promise(resolve => setTimeout(resolve, delay));

  const jobId = uuidv4();
  const tmpDir = `/tmp/${jobId}`;
  const clipsDir = `/tmp/clips/${jobId}`;

  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.mkdirSync(clipsDir, { recursive: true });

    const videoId = youtubeUrl.match(/(?:v=|youtu\.be\/)([^&\n?#]+)/)?.[1];
    if (!videoId) throw new Error('Invalid YouTube URL.');

    const targetUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const videoPath = `${tmpDir}/video.mp4`;

    console.log(`Downloading: ${targetUrl}`);
    const command = buildYtDlpCommand(targetUrl, videoPath);
    console.log('Command:', command);

    try {
      await execPromise(command);
      console.log('Download complete.');
    } catch (error) {
      const raw = error && typeof error === 'object' && 'stderr' in error
        ? String(error.stderr)
        : error instanceof Error ? error.message : String(error);
      console.error('yt-dlp error:', raw);
      return res.status(500).json({ error: mapYtDlpError(raw), debug: raw.slice(-1500) });
    }

    console.log('Extracting audio...');
    const audioPath = `${tmpDir}/audio.mp3`;
    await run(`ffmpeg -hide_banner -loglevel error -i "${videoPath}" -vn -c:a libmp3lame -b:a 64k -ac 1 "${audioPath}" -y`);

    console.log('Transcribing...');
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: 'whisper-1',
      response_format: 'verbose_json',
      timestamp_granularities: ['word', 'segment']
    });

    const segments = transcription.segments || [];
    const allWords = transcription.words || [];
    const fullText = segments.map(s => `[${s.start.toFixed(1)}s-${s.end.toFixed(1)}s]: ${s.text}`).join('\n');

    console.log('Finding best moments...');
    const gptResponse = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: `You are a viral video editor. Given this transcript with timestamps, find the 5 most engaging moments for TikTok/YouTube Shorts (30-60 seconds each).

Transcript:
${fullText}

Return ONLY a JSON array, no other text:
[
  { "start": 10.5, "end": 45.2, "title": "Title", "subtitle": "Description" }
]
Rules: each clip 25-60 seconds, return exactly 5 clips, only the JSON array.`
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
      return res.status(500).json({ error: 'Failed to parse AI response' });
    }

    console.log('Cutting clips sequentially...');
    
    const backendUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 8000}`;
    
    const clips = [];
    for (const moment of moments) {
      const clipId = uuidv4();
      const clipPath = `${clipsDir}/${clipId}.mp4`;
      const duration = moment.end - moment.start;
      
      const assPath = `${tmpDir}/${clipId}.ass`;
      
      let assContent = `[Script Info]
ScriptType: v4.00+
PlayResX: 720
PlayResY: 1280

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Main,Arial,60,&H0000FFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,2,5,20,20,300,1

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

      const clipWords = allWords.filter(w => w.start >= moment.start && w.end <= moment.end);
      
      if (clipWords.length > 0) {
        for (let i = 0; i < clipWords.length; i += 2) {
          const w1 = clipWords[i];
          const w2 = clipWords[i+1];
          const start = formatAssTime(w1.start - moment.start);
          const end = formatAssTime((w2 ? w2.end : w1.end) - moment.start);
          const text = (w1.word + (w2 ? w2.word : "")).trim().replace(/\s+/g, " ");
          assContent += `Dialogue: 0,${start},${end},Main,,0,0,0,,{\\b1}${text}\n`;
        }
      } else {
        const secEnd = Math.floor(duration).toString().padStart(2,'0');
        assContent += `Dialogue: 0,0:00:00.00,0:00:${secEnd}.00,Main,,0,0,0,,{\\b1}${moment.subtitle || moment.title}\n`;
      }

      fs.writeFileSync(assPath, assContent);
      const escapedAssPath = assPath.replace(/\\/g, '/').replace(/:/g, '\\\\:');

      try {
        console.log(`Generating clip: ${moment.title} (${duration.toFixed(1)}s)`);
        await run(`ffmpeg -hide_banner -loglevel error -ss ${moment.start} -i "${videoPath}" -t ${duration} -vf "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,subtitles='${escapedAssPath}',format=yuv420p" -c:v libx264 -c:a aac -b:a 128k -preset veryfast -crf 28 -maxrate 1.5M -bufsize 3M "${clipPath}" -y`);
        
        clips.push({
          id: clipId,
          videoUrl: `${backendUrl}/clips/${jobId}/${clipId}.mp4`,
          duration: Math.round(duration),
          title: moment.title || 'Clip',
          subtitle: moment.subtitle,
          startTime: moment.start,
          endTime: moment.end
        });
      } catch (err) {
        console.error(`Failed to generate clip ${clipId}:`, err.message || err);
      }
    }

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
