import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import Busboy from 'busboy';

const PORT = Number(process.env.CLIPPER_SERVER_PORT || 3030);
const ROOT_DIR = path.resolve(process.cwd());
const OUTPUT_DIR = path.join(ROOT_DIR, 'local-exports');
const FONT_PATHS = [
  'C:/Windows/Fonts/arialbd.ttf',
  'C:/Windows/Fonts/Arialbd.ttf',
  'C:/Windows/Fonts/calibrib.ttf',
];

// Groq Whisper API key (free: https://console.groq.com/keys)
const GROQ_API_KEY = process.env.GROQ_API_KEY || 'REMOVED_GROQ_KEY';

await fsp.mkdir(OUTPUT_DIR, { recursive: true });

const sendJson = (res, statusCode, payload) => {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(payload));
};

const runCommand = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { windowsHide: true, ...options });
  let stdout = '';
  let stderr = '';

  child.stdout.on('data', chunk => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });
  child.on('error', reject);
  child.on('close', code => {
    if (code === 0) {
      resolve({ stdout, stderr });
      return;
    }
    reject(new Error(stderr || stdout || `${command} exited with code ${code}`));
  });
});

const runCommandWithProgress = (command, args, options = {}, onProgress) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { windowsHide: true, ...options });
  let stderr = '';
  let stdoutBuf = '';

  child.stdout.on('data', chunk => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() || '';
    for (const line of lines) {
      if (onProgress && line.startsWith('out_time_ms=')) {
        const us = parseInt(line.split('=')[1], 10);
        if (!isNaN(us) && us >= 0) onProgress(us / 1000000);
      }
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.on('error', reject);
  child.on('close', code => {
    if (code === 0) resolve({ stdout: stdoutBuf, stderr });
    else reject(new Error(stderr || `${command} exited with code ${code}`));
  });
});

// SSE job tracking
const sseClients = new Map();
const jobResults = new Map();
let jobCounter = 0;

const sendSseEvent = (jobId, eventName, data) => {
  const client = sseClients.get(jobId);
  if (!client || client.closed) return;
  try {
    client.res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch { /* ignore write errors */ }
};

const fileExists = async (targetPath) => {
  try {
    await fsp.access(targetPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const getUsableFontPath = async () => {
  for (const fontPath of FONT_PATHS) {
    if (await fileExists(fontPath)) {
      return fontPath.replace(/\\/g, '/').replace(':', '\\:');
    }
  }
  return null;
};

const sanitizeName = (value) => value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'clip';

// Format seconds to ASS timestamp: H:MM:SS.CC
const toAssTime = (seconds) => {
  const s = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.round((s % 1) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
};

// Escape special ASS characters in dialogue text
const escapeAssText = (text) => String(text || '')
  .replace(/\\/g, '\\\\')
  .replace(/\{/g, '\\{')
  .replace(/\}/g, '\\}');

// Generate an ASS subtitle file. Returns the file path.
// subtitleY: 0 = bottom, 100 = top (user slider)
// The ASS format handles word-wrapping automatically via PlayResX/MarginL/MarginR.
const generateAssFile = async (captions, subtitleSize, subtitleY, outputAssPath, videoWidth = 1080, videoHeight = 1920) => {
  const fontSize = Math.max(20, Math.round(Number(subtitleSize || 22) * 3));
  const outlineSize = Math.max(2, Math.round(fontSize / 14));
  const shadowSize = 1;
  const marginH = 60; // horizontal margin (left + right) in pixels — prevents edge overflow
  
  // ASS Alignment: 2 = bottom-center (default)
  // We use MarginV to shift vertically. subtitleY: 0=bottom, 100=top
  const yRatio = Math.max(0, Math.min(100, Number(subtitleY ?? 0))) / 100;
  // MarginV from bottom: 0% → small margin (40px), 100% → near top
  const marginV = Math.round(40 + yRatio * (videoHeight - fontSize * 2 - 80));
  
  const assContent = `[Script Info]
Title: Subtitle
ScriptType: v4.00+
WrapStyle: 0
PlayResX: ${videoWidth}
PlayResY: ${videoHeight}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${outlineSize},${shadowSize},2,${marginH},${marginH},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${captions.map(c => {
    const text = escapeAssText(c.text || '').toUpperCase();
    return `Dialogue: 0,${toAssTime(c.start_offset)},${toAssTime(c.end_offset)},Default,,0,0,0,,${text}`;
  }).join('\n')}
`;

  await fsp.writeFile(outputAssPath, assContent, 'utf-8');
  return outputAssPath;
};

// Auto-split captions that are too long into word-group chunks
// so subtitles animate through the whole clip duration.
const splitLongCaptions = (captions, clipDuration) => {
  const MAX_LINE_DURATION = 3.5; // seconds max per subtitle line
  const WORDS_PER_LINE = 2;      // target words per line (narrow 9:16 video)
  const result = [];

  for (const caption of captions) {
    const start = Number(caption.start_offset ?? 0);
    const end = Number(caption.end_offset ?? clipDuration);
    const dur = end - start;
    const words = String(caption.text || '').trim().split(/\s+/).filter(Boolean);

    // If short enough AND text fits on one line, keep as-is
    if (dur <= MAX_LINE_DURATION && words.length <= WORDS_PER_LINE * 2) {
      result.push(caption);
      continue;
    }

    // How many chunks do we need?
    const chunksByDuration = Math.ceil(dur / MAX_LINE_DURATION);
    const chunksByWords = Math.ceil(words.length / WORDS_PER_LINE);
    const numChunks = Math.max(chunksByDuration, chunksByWords);

    if (numChunks <= 1) {
      result.push(caption);
      continue;
    }

    // Build word chunks
    const wordsPerChunk = Math.ceil(words.length / numChunks);
    const chunks = [];
    for (let i = 0; i < numChunks; i++) {
      const slice = words.slice(i * wordsPerChunk, (i + 1) * wordsPerChunk);
      if (slice.length > 0) chunks.push(slice.join(' '));
    }

    // If there are more duration slots than word chunks, repeat last word to fill time
    while (chunks.length < numChunks) chunks.push(chunks[chunks.length - 1]);

    const segDur = dur / chunks.length;
    chunks.forEach((text, i) => {
      result.push({
        text,
        start_offset: parseFloat((start + i * segDur).toFixed(2)),
        end_offset: parseFloat((start + (i + 1) * segDur - 0.08).toFixed(2)),
      });
    });
  }

  return result;
};

// Transcribe audio from a clip using Groq Whisper API
const transcribeClipAudio = async (clipPath, clipDuration) => {
  // Extract audio to temporary WAV
  const tempWav = clipPath + '.transcribe.wav';
  await runCommand('ffmpeg', [
    '-y', '-i', clipPath,
    '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1',
    tempWav,
  ]);

  try {
    const audioBuffer = await fsp.readFile(tempWav);
    const formData = new FormData();
    formData.append('file', new Blob([audioBuffer], { type: 'audio/wav' }), 'audio.wav');
    formData.append('model', 'whisper-large-v3-turbo');
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities[]', 'word');
    formData.append('language', 'id');

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` },
      body: formData,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Groq Whisper API error ${response.status}: ${errText}`);
    }

    const result = await response.json();
    const words = result.words || [];

    if (words.length === 0) {
      // Fallback: return full text as one caption
      return result.text
        ? [{ text: result.text, start_offset: 0, end_offset: clipDuration }]
        : [];
    }

    // Group words into subtitle lines (2 words per line to fit narrow 9:16 video)
    const WORDS_PER_LINE = 2;
    const captions = [];
    for (let i = 0; i < words.length; i += WORDS_PER_LINE) {
      const chunk = words.slice(i, i + WORDS_PER_LINE);
      captions.push({
        text: chunk.map(w => w.word).join(' '),
        start_offset: parseFloat(Number(chunk[0].start).toFixed(2)),
        end_offset: parseFloat(Number(chunk[chunk.length - 1].end).toFixed(2)),
      });
    }
    return captions;
  } finally {
    await fsp.unlink(tempWav).catch(() => {});
  }
};

const buildFilter = (captions, subtitleSize, subtitleY, fontPath) => {
  const filters = ['crop=ih*(9/16):ih:(iw-ow)/2:0'];
  if (!fontPath || !Array.isArray(captions) || captions.length === 0) {
    return filters.join(',');
  }

  const fontSize = Math.max(16, Math.round(Number(subtitleSize || 22) * 3));
  const borderW = Math.max(2, Math.round(fontSize / 12));
  const MARGIN = 40;
  const yRatioNum = (Math.max(0, Math.min(100, Number(subtitleY ?? 0))) / 100);
  const yPos = `(h-th-${MARGIN})*${(1 - yRatioNum).toFixed(3)}+${Math.round(MARGIN / 2)}`;

  captions.forEach((caption) => {
    const safeText = escapeDrawText(String(caption.text || '').toUpperCase());
    const start = Number(caption.start_offset || 0).toFixed(2);
    const end = Number(caption.end_offset || 0).toFixed(2);
    filters.push(
      `drawtext=fontfile='${fontPath}':text='${safeText}':fontsize=${fontSize}:fontcolor=white:borderw=${borderW}:bordercolor=black:x=max(${MARGIN}\\,(w-tw)/2):y=${yPos}:enable='between(t\\,${start}\\,${end})'`
    );
  });

  return filters.join(',');
};

const normalizeMoments = (moments) => {
  if (!Array.isArray(moments)) return [];
  return moments.slice(0, 5).map((moment, index) => {
    const start = Math.max(0, Number(moment.start || 0));
    const end = Math.max(start + 1, Number(moment.end || start + 15));
    const duration = end - start;
    const captions = Array.isArray(moment.captions) && moment.captions.length > 0
      ? moment.captions.map((caption, captionIndex, all) => {
          const segment = duration / all.length;
          return {
            text: caption.text || `CLIP ${index + 1}`,
            start_offset: Number.isFinite(Number(caption.start_offset)) ? Number(caption.start_offset) : Number((captionIndex * segment).toFixed(2)),
            end_offset: Number.isFinite(Number(caption.end_offset)) ? Number(caption.end_offset) : Number((((captionIndex + 1) * segment) - 0.05).toFixed(2)),
          };
        })
      : [{ text: moment.title || `CLIP ${index + 1}`, start_offset: 0, end_offset: duration }];

    return {
      id: index + 1,
      title: moment.title || `Clip ${index + 1}`,
      start,
      end,
      duration,
      captions,
    };
  });
};

const parseMultipart = (req) => new Promise((resolve, reject) => {
  const busboy = Busboy({ headers: req.headers });
  const fields = {};
  let videoPath = null;
  let videoName = 'video.mp4';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipper-'));

  busboy.on('field', (name, value) => {
    fields[name] = value;
  });

  busboy.on('file', (name, file, info) => {
    if (name !== 'video') {
      file.resume();
      return;
    }
    videoName = info.filename || videoName;
    videoPath = path.join(tempDir, sanitizeName(path.parse(videoName).name) + path.extname(videoName || '.mp4'));
    const stream = fs.createWriteStream(videoPath);
    file.pipe(stream);
    stream.on('error', reject);
  });

  busboy.on('finish', () => {
    resolve({ fields, videoPath, tempDir, videoName });
  });
  busboy.on('error', reject);
  req.pipe(busboy);
});

const removeDirSafe = async (dirPath) => {
  if (!dirPath) return;
  try {
    await fsp.rm(dirPath, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
};

const processJob = async (jobId, videoPath, moments, tempDir) => {
  const created = [];
  const totalClips = moments.length;
  try {
    for (let i = 0; i < moments.length; i++) {
      const moment = moments[i];
      const clipDuration = moment.duration;

      sendSseEvent(jobId, 'progress', {
        step: `Clip ${i + 1} / ${totalClips}: ${moment.title}`,
        detail: 'Memotong clip...',
        percent: Math.round(20 + (i / totalClips) * 75),
      });

      const outputFile = `plain_${sanitizeName(moment.title)}_${moment.id}_${Date.now()}.mp4`;
      const outputPath = path.join(OUTPUT_DIR, outputFile);

      // Extract a sample frame for face detection
      const framePath = path.join(tempDir, `frame_${moment.id}.jpg`);
      const sampleSec = Math.max(0, Math.min(moment.start + 1, moment.start + Math.max(0.5, Math.floor(clipDuration / 2))));
      await runCommand('ffmpeg', ['-y', '-ss', String(sampleSec), '-i', videoPath, '-vframes', '1', '-q:v', '2', framePath]);

      // Default: center crop
      let vf = 'crop=ih*(9/16):ih:(iw-ow)/2:0';

      try {
        const py = spawnSync('python', [path.join(ROOT_DIR, 'server', 'face_detect.py'), framePath], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
        if (py && py.stdout) {
          try {
            const info = JSON.parse(py.stdout.trim());
            if (info && info.face) {
              const imgW = Number(info.width || 0);
              const imgH = Number(info.height || 0);
              const face = info.face;
              // compute crop width based on image height (same logic as crop=ih*(9/16))
              const cropW = Math.round(imgH * (9/16));
              if (imgW > cropW) {
                let cropX = Math.round(face.cx - cropW / 2);
                cropX = Math.max(0, Math.min(cropX, imgW - cropW));
                vf = `crop=${cropW}:${imgH}:${cropX}:0`;
              }
            }
          } catch (e) {
            // ignore parse errors, keep center crop
          }
        }
      } catch (err) {
        // if python call fails, fallback to centered crop
      }

      const args = [
        '-y',
        '-ss', String(moment.start),
        '-i', videoPath,
        '-t', String(clipDuration),
        '-vf', vf,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '23',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        '-progress', 'pipe:1',
        outputPath,
      ];

      await runCommandWithProgress('ffmpeg', args, {}, (processedSeconds) => {
        const clipPct = Math.min(1, processedSeconds / Math.max(clipDuration, 0.1));
        const overall = Math.round(20 + ((i + clipPct) / totalClips) * 75);
        sendSseEvent(jobId, 'progress', {
          step: `Clip ${i + 1} / ${totalClips}: ${moment.title}`,
          detail: `${Math.round(clipPct * 100)}% selesai`,
          percent: overall,
        });
      });

      created.push({
        id: moment.id,
        title: moment.title,
        filename: outputFile,
        url: `/outputs/${encodeURIComponent(outputFile)}`,
        captions: moment.captions,
        duration: clipDuration,
      });
    }

    const result = { ok: true, clips: created, mode: 'system-ffmpeg' };
    jobResults.set(jobId, result);
    sendSseEvent(jobId, 'done', result);
    const client = sseClients.get(jobId);
    if (client && !client.closed) client.res.end();
    sseClients.delete(jobId);
  } catch (error) {
    const result = { ok: false, error: error.message || 'Processing gagal.' };
    jobResults.set(jobId, result);
    sendSseEvent(jobId, 'done', result);
    const client = sseClients.get(jobId);
    if (client && !client.closed) client.res.end();
    sseClients.delete(jobId);
  } finally {
    await removeDirSafe(tempDir);
  }
};

const addSubtitleJob = async (jobId, inputPath, captions, subtitleSize, subtitleY, clipDuration) => {
  let assPath = null;
  try {
    // Step 1: Transcribe actual audio if Groq API key is available
    let finalCaptions = captions;
    if (GROQ_API_KEY) {
      sendSseEvent(jobId, 'progress', { step: 'Transkripsi audio...', detail: 'Mengenali kata-kata dalam audio...', percent: 5 });
      try {
        const transcribed = await transcribeClipAudio(inputPath, clipDuration);
        if (transcribed && transcribed.length > 0) {
          finalCaptions = transcribed;
        }
      } catch (err) {
        console.error('Transcription failed, falling back to AI captions:', err.message);
        sendSseEvent(jobId, 'progress', { step: 'Transkripsi gagal', detail: 'Menggunakan caption AI sebagai fallback...', percent: 8 });
      }
    }

    // Step 2: Split long captions into timed word-group chunks
    const timedCaptions = splitLongCaptions(finalCaptions, clipDuration);

    if (!timedCaptions || timedCaptions.length === 0) {
      const result = { ok: false, error: 'Tidak ada subtitle yang bisa dihasilkan.' };
      jobResults.set(jobId, result);
      sendSseEvent(jobId, 'done', result);
      const client = sseClients.get(jobId);
      if (client && !client.closed) client.res.end();
      sseClients.delete(jobId);
      return;
    }

    // Step 3: Generate ASS subtitle file
    sendSseEvent(jobId, 'progress', { step: 'Membuat file subtitle...', detail: '', percent: 10 });
    assPath = inputPath + `.sub_${Date.now()}.ass`;
    await generateAssFile(timedCaptions, subtitleSize, subtitleY, assPath);

    const baseName = path.parse(inputPath).name.replace(/^plain_/, 'sub_');
    const outputFile = `${baseName}_${Date.now()}.mp4`;
    const outputPath = path.join(OUTPUT_DIR, outputFile);

    sendSseEvent(jobId, 'progress', { step: 'Menambahkan subtitle...', detail: '0%', percent: 15 });

    // Use ass= filter (handles word-wrap, margins, styling automatically)
    // On Windows, FFmpeg requires forward slashes and escaped colons in paths
    const assPathForFFmpeg = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');

    const args = [
      '-y',
      '-i', inputPath,
      '-vf', `ass='${assPathForFFmpeg}'`,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      '-progress', 'pipe:1',
      outputPath,
    ];

    await runCommandWithProgress('ffmpeg', args, {}, (processedSeconds) => {
      const pct = Math.min(100, Math.round((processedSeconds / Math.max(clipDuration, 0.1)) * 100));
      sendSseEvent(jobId, 'progress', { step: 'Menambahkan subtitle...', detail: `${pct}%`, percent: Math.min(95, pct) });
    });

    // Cleanup ASS file
    if (assPath) await fsp.unlink(assPath).catch(() => {});

    const result = { ok: true, filename: outputFile, url: `/outputs/${encodeURIComponent(outputFile)}` };
    jobResults.set(jobId, result);
    sendSseEvent(jobId, 'done', result);
    const client = sseClients.get(jobId);
    if (client && !client.closed) client.res.end();
    sseClients.delete(jobId);
  } catch (error) {
    if (assPath) await fsp.unlink(assPath).catch(() => {});
    const result = { ok: false, error: error.message || 'Gagal menambahkan subtitle.' };
    jobResults.set(jobId, result);
    sendSseEvent(jobId, 'done', result);
    const client = sseClients.get(jobId);
    if (client && !client.closed) client.res.end();
    sseClients.delete(jobId);
  }
};

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/api/health') {
    try {
      await runCommand('ffmpeg', ['-version']);
      sendJson(res, 200, { ok: true, mode: 'system-ffmpeg' });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === 'GET' && req.url?.startsWith('/outputs/')) {
    const requested = decodeURIComponent(req.url.replace('/outputs/', ''));
    const safeName = path.basename(requested);
    const filePath = path.join(OUTPUT_DIR, safeName);
    if (!(await fileExists(filePath))) {
      sendJson(res, 404, { ok: false, error: 'File not found' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  if (req.method === 'GET' && req.url?.startsWith('/api/progress/')) {
    const jobId = req.url.split('/api/progress/')[1];
    if (!jobResults.has(jobId)) {
      sendJson(res, 404, { ok: false, error: 'Job not found' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(':ok\n\n');
    const existingResult = jobResults.get(jobId);
    if (existingResult !== null) {
      res.write(`event: done\ndata: ${JSON.stringify(existingResult)}\n\n`);
      res.end();
      return;
    }
    const client = { res, closed: false };
    sseClients.set(jobId, client);
    req.on('close', () => { client.closed = true; });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/process') {
    let parsed;
    try {
      parsed = await parseMultipart(req);
      const { fields, videoPath, tempDir } = parsed;
      if (!videoPath || !(await fileExists(videoPath))) {
        sendJson(res, 400, { ok: false, error: 'Video file tidak ditemukan di request.' });
        await removeDirSafe(tempDir);
        return;
      }

      const moments = normalizeMoments(JSON.parse(fields.moments || '[]'));
      const jobId = `job_${++jobCounter}_${Date.now()}`;

      jobResults.set(jobId, null); // mark as in-progress
      processJob(jobId, videoPath, moments, tempDir);
      sendJson(res, 200, { ok: true, jobId });
    } catch (error) {
      if (parsed?.tempDir) {
        await removeDirSafe(parsed.tempDir);
      }
      sendJson(res, 500, { ok: false, error: error.message || 'Processing gagal.' });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/add-subtitle') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const { clipFilename, captions, subtitleSize, subtitleY, clipDuration } = JSON.parse(body);
        const safeName = path.basename(clipFilename);
        const inputPath = path.join(OUTPUT_DIR, safeName);
        if (!(await fileExists(inputPath))) {
          sendJson(res, 404, { ok: false, error: 'Clip file tidak ditemukan.' });
          return;
        }
        const jobId = `sub_${++jobCounter}_${Date.now()}`;
        jobResults.set(jobId, null);
        addSubtitleJob(jobId, inputPath, captions || [], subtitleSize || 22, subtitleY ?? 0, clipDuration || 30);
        sendJson(res, 200, { ok: true, jobId });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error.message || 'Invalid request.' });
      }
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`Local FFmpeg server running on http://localhost:${PORT}`);
});