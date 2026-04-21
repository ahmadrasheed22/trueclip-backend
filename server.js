const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());
app.use('/clips', express.static('/tmp/clips'));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function updateYtDlp() {
  try { await run('yt-dlp -U'); } catch(e) { console.log('yt-dlp update skipped'); }
}

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 100 }, (err, stdout, stderr) => {
      if (err) reject(stderr || err.message);
      else resolve(stdout);
    });
  });
}

app.get('/', (req, res) => res.json({ status: 'Trueclip backend running ✅' }));

app.post('/generate', async (req, res) => {
  const { youtubeUrl } = req.body;

  if (!youtubeUrl) {
    return res.status(400).json({ error: 'YouTube URL is required' });
  }

  const jobId = uuidv4();
  const tmpDir = `/tmp/${jobId}`;
  const clipsDir = `/tmp/clips/${jobId}`;

  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.mkdirSync(clipsDir, { recursive: true });

    console.log('Downloading video...');
    const videoPath = `${tmpDir}/video.mp4`;
  await run(`yt-dlp --extractor-args "youtube:player_client=web" --add-headers "User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" -f "best[height<=720][ext=mp4]" --no-playlist -o "${videoPath}" "${youtubeUrl}"`);

    console.log('Extracting audio...');
    const audioPath = `${tmpDir}/audio.mp3`;
    await run(`ffmpeg -i "${videoPath}" -q:a 0 -map a "${audioPath}" -y`);

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

      await run(`ffmpeg -ss ${moment.start} -i "${videoPath}" -t ${duration} -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,subtitles='${srtPath}':force_style='FontSize=18,PrimaryColour=&HFFFFFF,OutlineColour=&H000000,Bold=1'" -c:v libx264 -c:a aac -preset fast "${clipPath}" -y`);

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
updateYtDlp();
app.listen(PORT, () => console.log(`Trueclip backend running on port ${PORT}`));
