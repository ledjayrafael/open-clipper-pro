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

// API keys come from the environment or a gitignored .env file in the project root.
try {
  process.loadEnvFile(path.join(ROOT_DIR, '.env'));
} catch {
  // no .env file: rely on real environment variables
}
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-3.1-flash-lite-preview';
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || '';
const AI_PROVIDER = process.env.AI_PROVIDER === 'ollama' ? 'ollama' : 'openrouter';
if (!OPENROUTER_API_KEY) console.warn('OPENROUTER_API_KEY belum diset (lihat .env.example). Mode OpenRouter tidak tersedia; mode Ollama tetap bisa dipakai.');
// Whisper language hint; set WHISPER_LANGUAGE= (empty) in .env for auto-detect.
const WHISPER_LANGUAGE = process.env.WHISPER_LANGUAGE ?? 'id';
// Full-video transcription is sent to Groq in chunks of this many seconds.
const WHISPER_CHUNK_SECONDS = 600;
const WORDS_DIR_NAME = '.words';
if (!GROQ_API_KEY) console.warn('GROQ_API_KEY belum diset. AI hanya melihat durasi video (tanpa transkrip) dan subtitle memakai caption AI.');

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });

// Returns installed Ollama model names, or null when Ollama is unreachable.
async function listOllamaModels() {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return null;
    const data = await response.json();
    return (data.models || []).map(m => m.name).filter(Boolean);
  } catch {
    return null;
  }
}

async function callOpenRouter(messages) {
  if (!OPENROUTER_API_KEY) throw httpError(500, 'OPENROUTER_API_KEY belum diset di .env server. Pakai mode Ollama atau isi key-nya.');
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENROUTER_API_KEY}` },
    body: JSON.stringify({ model: OPENROUTER_MODEL, messages, response_format: { type: 'json_object' } }),
    signal: AbortSignal.timeout(180000),
  }).catch(error => {
    if (error.name === 'TimeoutError') throw httpError(504, 'OpenRouter tidak menjawab dalam 3 menit. Coba lagi.');
    throw httpError(502, `Gagal menghubungi OpenRouter: ${error.message}`);
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw httpError(502, `OpenRouter error ${response.status}: ${errText.slice(0, 300)}`);
  }
  const result = await response.json();
  return result.choices?.[0]?.message?.content || '';
}

// Structured-output schema for Ollama. With plain format:'json' small local
// models often answer {"moments":[]}; the schema forces real segments.
// Captions are only asked for when there is no transcript to take them from.
const momentsSchema = (count, withCaptions) => {
  const required = ['start', 'end', 'title', 'viral_score', 'reason'];
  const properties = {
    start: { type: 'number' }, end: { type: 'number' }, title: { type: 'string' },
    viral_score: { type: 'integer' }, reason: { type: 'string' },
  };
  if (withCaptions) {
    required.push('captions');
    properties.captions = {
      type: 'array', minItems: 1,
      items: {
        type: 'object', required: ['text', 'start_offset', 'end_offset'],
        properties: { text: { type: 'string' }, start_offset: { type: 'number' }, end_offset: { type: 'number' } },
      },
    };
  }
  return {
    type: 'object',
    required: ['moments'],
    properties: { moments: { type: 'array', minItems: 1, maxItems: count, items: { type: 'object', required, properties } } },
  };
};

async function callOllama(messages, requestedModel, { schema, numCtx } = {}) {
  const models = await listOllamaModels();
  if (models === null) throw httpError(502, `Ollama tidak jalan di ${OLLAMA_URL}. Jalankan "ollama serve" dulu.`);
  if (models.length === 0) throw httpError(502, 'Belum ada model Ollama. Jalankan misalnya "ollama pull gemma4:e4b".');
  const model = requestedModel || (models.includes(OLLAMA_MODEL) ? OLLAMA_MODEL : models[0]);
  if (!models.includes(model)) throw httpError(400, `Model Ollama "${model}" tidak terpasang.`);

  let response;
  try {
    response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, messages, stream: false, format: schema || 'json', think: false,
        options: { temperature: 0.4, ...(numCtx ? { num_ctx: numCtx } : {}) },
      }),
      signal: AbortSignal.timeout(300000),
    });
  } catch (error) {
    if (error.name === 'TimeoutError') throw httpError(504, `Ollama (${model}) tidak menjawab dalam 5 menit.`);
    throw httpError(502, `Gagal menghubungi Ollama: ${error.message}`);
  }
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw httpError(502, `Ollama error ${response.status}: ${errText.slice(0, 300)}`);
  }
  const result = await response.json();
  // Reasoning models may still emit their thinking inline.
  return String(result.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// ---------------------------------------------------------------------------
// Transcript-based highlight detection
// ---------------------------------------------------------------------------

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// Usable length of the video. When the video track ends before the audio,
// clips past that point would have no picture, so the shorter one wins.
// Containers without per-stream durations (mkv, webm) fall back to the format's.
const probeDuration = async (filePath) => {
  const read = async (args) => {
    const { stdout } = await runCommand('ffprobe', ['-v', 'error', ...args, '-of', 'default=nw=1:nk=1', filePath]);
    return Number(stdout.trim().split('\n')[0]) || 0;
  };
  const format = await read(['-show_entries', 'format=duration']);
  const video = await read(['-select_streams', 'v:0', '-show_entries', 'stream=duration']).catch(() => 0);
  return video > 0 && (!format || video < format) ? video : format;
};

async function groqTranscribe(audioPath, mimeType, fileName) {
  const formData = new FormData();
  formData.append('file', new Blob([await fsp.readFile(audioPath)], { type: mimeType }), fileName);
  formData.append('model', 'whisper-large-v3-turbo');
  formData.append('response_format', 'verbose_json');
  formData.append('timestamp_granularities[]', 'word');
  formData.append('timestamp_granularities[]', 'segment');
  if (WHISPER_LANGUAGE) formData.append('language', WHISPER_LANGUAGE);

  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` },
    body: formData,
    signal: AbortSignal.timeout(300000),
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Groq Whisper error ${response.status}: ${errText.slice(0, 300)}`);
  }
  const result = await response.json();
  return { words: result.words || [], segments: result.segments || [], text: result.text || '' };
}

// Transcribe the whole video in chunks. Returns absolute-time words and lines.
async function transcribeFullVideo(videoPath, tempDir, duration, onChunk) {
  const words = [];
  const segments = [];
  const chunks = Math.max(1, Math.ceil(duration / WHISPER_CHUNK_SECONDS));
  for (let i = 0; i < chunks; i++) {
    const offset = i * WHISPER_CHUNK_SECONDS;
    const audioPath = path.join(tempDir, `audio_${i}.ogg`);
    // Opus at 32 kbps keeps a 10-minute chunk around 2.4 MB, far under Groq's upload limit.
    await runCommand('ffmpeg', [
      '-y', '-ss', String(offset), '-t', String(WHISPER_CHUNK_SECONDS), '-i', videoPath,
      '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '32k', audioPath,
    ]);
    const result = await groqTranscribe(audioPath, 'audio/ogg', 'audio.ogg');
    await fsp.unlink(audioPath).catch(() => {});
    for (const w of result.words) {
      const text = String(w.word || '').trim();
      if (text) words.push({ word: text, start: Number(w.start) + offset, end: Number(w.end) + offset });
    }
    for (const s of result.segments) {
      const text = String(s.text || '').trim();
      if (text) segments.push({ text, start: Number(s.start) + offset, end: Number(s.end) + offset });
    }
    onChunk?.(i + 1, chunks);
  }
  // Drop speech past the usable video length (audio can outlast the picture).
  const usableWords = words.filter(w => w.start < duration);
  const usableLines = segments.filter(s => s.start < duration);
  return { words: usableWords, lines: usableLines.length ? usableLines : linesFromWords(usableWords) };
}

// Fallback when Whisper returns words but no segments.
const linesFromWords = (words) => {
  const lines = [];
  let current = null;
  for (const w of words) {
    if (!current || w.start - current.end > 1 || current.count >= 14) {
      current = { text: '', start: w.start, end: w.end, count: 0 };
      lines.push(current);
    }
    current.text += (current.text ? ' ' : '') + w.word;
    current.end = w.end;
    current.count++;
  }
  return lines.map(({ text, start, end }) => ({ text, start, end }));
};

const formatTranscript = (lines) => lines
  .map(l => `[${l.start.toFixed(1)}-${l.end.toFixed(1)}] ${l.text}`)
  .join('\n');

const buildTranscriptPrompt = ({ duration, requestCount, minDur, maxDur }) => `You are a top-tier short-form video editor cutting viral clips for TikTok, Instagram Reels and YouTube Shorts.

The user message is the full transcript of a ${Math.round(duration)}-second video. Each line is "[start-end] text", times in seconds.

TASK: return ${requestCount} candidate segments, best first.

PICK segments that have:
1. Conflict, tension or controversy.
2. A personal confession or a vulnerable moment.
3. A bold opinion or a sharp statement.
4. A punchline or a genuinely funny beat.
5. A complete story arc: setup, build-up, payoff.
6. An opening sentence that works as a hook on its own.

AVOID greetings, intros and outros, small talk, sponsor reads, topic transitions without a payoff, and long dry explanations. When in doubt, choose emotion and conflict over neutral information.

Read the WHOLE transcript before choosing. The best moments are rarely all at the start: spread your picks across the full runtime.

RULES:
- Every segment lasts ${minDur}-${maxDur} seconds; aim for about ${Math.round((minDur + maxDur) / 2)}. Compute length from the timestamps, never from how much text there is.
- "start" is the start time of a line where a sentence begins. "end" is the end time of a line where the thought is finished. Copy times from the transcript; never invent times and never cut mid-sentence.
- Segments must not overlap.
- "viral_score" is 1-100. Be honest and spread the scores; do not give everything 90.
- "title": a short catchy title (max 8 words), casual spoken style.
- "reason": one short sentence on why this segment would go viral.
- LANGUAGE: write "title" and "reason" in the SAME language as the transcript. An Indonesian transcript gets Indonesian titles and reasons. Use English only if the transcript itself is English.

Output ONLY JSON, no prose:
{"moments":[{"start":12.4,"end":58.9,"title":"...","viral_score":87,"reason":"..."}]}`;

// Used when no transcript is available: the AI only knows the duration.
const buildMetadataPrompt = ({ duration, requestCount, minDur, maxDur }) => `Anda adalah ahli editor video viral profesional.
Video berdurasi ${Math.round(duration)} detik. Temukan ${requestCount} segmen terbaik untuk clip viral vertikal (Reels/TikTok/Shorts).
ATURAN:
- start dan end dalam detik, rentang 0-${Math.round(duration)}
- Durasi tiap segmen ${minDur}-${maxDur} detik, TIDAK overlap
- Setiap segmen WAJIB punya "viral_score" (1-100) dan "reason" (satu kalimat)
- Setiap segmen WAJIB punya array 'captions' (4-6 caption per segmen, maks 8 kata per caption)
- Caption: text, start_offset, end_offset (relatif dari start segmen, detik)
- Urutkan dari viral_score tertinggi ke terendah
Format JSON MURNI:
{"moments":[{"start":0,"end":20,"title":"Hook Awal","viral_score":85,"reason":"...","captions":[{"text":"INI DIA RAHASIANYA","start_offset":0,"end_offset":4}]}]}`;

// Index of the brace closing the object that opens at `start`, or -1.
const matchBrace = (text, start) => {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
};

// Parse the model's moments, salvaging readable objects if the JSON is broken
// (models often emit one unescaped quote, which would otherwise sink the run).
const parseMomentsJson = (content) => {
  const raw = String(content || '').replace(/```(?:json)?/gi, '');
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try {
      const parsed = JSON.parse(raw.slice(first, last + 1));
      const list = Array.isArray(parsed) ? parsed : parsed.moments;
      if (Array.isArray(list)) return list;
    } catch { /* fall through to salvage */ }
  }
  const recovered = [];
  let index = 0;
  while ((index = raw.indexOf('{', index)) !== -1) {
    const close = matchBrace(raw, index);
    if (close !== -1) {
      try {
        const obj = JSON.parse(raw.slice(index, close + 1));
        if (obj && obj.start !== undefined && obj.end !== undefined) {
          recovered.push(obj);
          index = close + 1;
          continue;
        }
      } catch { /* broken object: try the next brace */ }
    }
    index++;
  }
  return recovered;
};

// Move a cut onto word boundaries so clips never start or end mid-word.
const snapToWords = (start, end, words, duration) => {
  const firstWord = words.find(w => w.end > start);
  let lastWord = null;
  for (const w of words) {
    if (w.start < end) lastWord = w;
    else break;
  }
  if (!firstWord || !lastWord || lastWord.end <= firstWord.start) return { start, end };
  return {
    start: Math.max(0, firstWord.start - 0.15),
    end: Math.min(duration, lastWord.end + 0.3),
  };
};

// A word belongs to the clip when its midpoint is inside it, so a word cut
// off at the clip's edge does not show up as a caption.
const wordsInRange = (words, start, end) => words
  .filter(w => (w.start + w.end) / 2 >= start && (w.start + w.end) / 2 < end)
  .map(w => ({ word: w.word, start: Math.max(0, w.start - start), end: Math.min(end, w.end) - start }));

// Group clip-relative words into short subtitle lines for a narrow 9:16 frame.
// Whisper word times can overlap, so each line starts after the previous one
// ends; otherwise two lines would be on screen at once.
const wordsToCaptions = (words, wordsPerLine = 2) => {
  const captions = [];
  let previousEnd = 0;
  for (let i = 0; i < words.length; i += wordsPerLine) {
    const chunk = words.slice(i, i + wordsPerLine);
    const start = Math.max(chunk[0].start, previousEnd);
    const end = Math.max(chunk[chunk.length - 1].end, start + 0.25);
    captions.push({
      text: chunk.map(w => w.word).join(' '),
      start_offset: Number(start.toFixed(2)),
      end_offset: Number(end.toFixed(2)),
    });
    previousEnd = end;
  }
  return captions;
};

// Turn raw AI moments into the final clip list: clamp, snap, enforce the
// duration window, drop overlaps, keep the best `count` by viral score.
const DURATION_TOLERANCE = 3;
const validateMoments = (rawMoments, { duration, minDur, maxDur, count, words, lines = [] }) => {
  const stats = { received: rawMoments.length, tooShort: 0, extended: 0, trimmed: 0, overlap: 0, invalid: 0 };
  const candidates = [];

  for (const m of rawMoments) {
    let start = Number(m.start);
    let end = Number(m.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) { stats.invalid++; continue; }
    start = clamp(start, 0, duration);
    end = clamp(end, 0, duration);
    if (end <= start) { stats.invalid++; continue; }
    if (words.length) ({ start, end } = snapToWords(start, end, words, duration));

    if (end - start > maxDur + DURATION_TOLERANCE) {
      // Too long: keep the opening (where the hook is) and end on a word.
      const limit = start + maxDur;
      const lastWord = [...words].reverse().find(w => w.end <= limit && w.start > start);
      end = lastWord ? Math.min(duration, lastWord.end + 0.3) : limit;
      stats.trimmed++;
    }
    if (end - start < minDur - DURATION_TOLERANCE) {
      // Too short (small models often pick a single line): keep the opening
      // and extend to the end of the transcript line that reaches minDur.
      const target = start + minDur;
      const line = lines.find(l => l.end >= target);
      end = line && line.end - start <= maxDur + DURATION_TOLERANCE ? line.end : Math.min(duration, target);
      if (end - start < minDur - DURATION_TOLERANCE) start = Math.max(0, end - minDur);
      stats.extended++;
    }
    if (end - start < minDur - DURATION_TOLERANCE) { stats.tooShort++; continue; }

    const rawCaptions = Array.isArray(m.captions) ? m.captions : [];
    candidates.push({
      start, end,
      title: String(m.title || '').trim().slice(0, 80) || 'Clip viral',
      reason: String(m.reason || '').trim().slice(0, 240),
      viralScore: clamp(Math.round(Number(m.viral_score) || 50), 1, 100),
      rawCaptions,
    });
  }

  candidates.sort((a, b) => b.viralScore - a.viralScore);
  const picked = [];
  for (const c of candidates) {
    if (picked.some(p => c.start < p.end - 1 && c.end > p.start + 1)) { stats.overlap++; continue; }
    picked.push(c);
    if (picked.length >= count) break;
  }

  const moments = picked.map((c, index) => {
    const clipDuration = Number((c.end - c.start).toFixed(2));
    const clipWords = words.length ? wordsInRange(words, c.start, c.end) : [];
    let captions;
    if (clipWords.length) {
      captions = wordsToCaptions(clipWords);
    } else if (c.rawCaptions.length) {
      const slot = clipDuration / c.rawCaptions.length;
      captions = c.rawCaptions.map((cap, i) => ({
        text: String(cap.text || '').trim() || c.title,
        start_offset: Number((i * slot).toFixed(2)),
        end_offset: Number(((i + 1) * slot - 0.05).toFixed(2)),
      }));
    } else {
      captions = [{ text: c.title, start_offset: 0, end_offset: clipDuration }];
    }
    return {
      id: index + 1, title: c.title, reason: c.reason, viralScore: c.viralScore,
      start: Number(c.start.toFixed(2)), end: Number(c.end.toFixed(2)), duration: clipDuration,
      captions, words: clipWords,
    };
  });
  return { moments, stats };
};

async function findMoments({ provider, model, duration, transcript, count, minDur, maxDur, words, lines }) {
  const requestCount = Math.min(15, count + 3); // over-request, then filter
  const settings = { duration, requestCount, minDur, maxDur };
  const messages = transcript
    ? [
        { role: 'system', content: buildTranscriptPrompt(settings) },
        { role: 'user', content: `TRANSCRIPT:\n${transcript}` },
      ]
    : [
        { role: 'system', content: buildMetadataPrompt(settings) },
        { role: 'user', content: `Temukan ${requestCount} segmen paling viral dari video berdurasi ${Math.round(duration)} detik.` },
      ];

  let content;
  if (provider === 'ollama') {
    // Ollama silently drops the start of a prompt longer than num_ctx, so size it to the transcript.
    const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
    const numCtx = clamp(Math.ceil(promptChars / 3) + 4096, 8192, 32768);
    content = await callOllama(messages, model, { schema: momentsSchema(requestCount, !transcript), numCtx });
  } else {
    content = await callOpenRouter(messages);
  }

  const raw = parseMomentsJson(content);
  if (raw.length === 0) throw new Error('AI tidak mengembalikan segmen yang bisa dibaca. Coba lagi atau ganti model.');
  const result = validateMoments(raw, { duration, minDur, maxDur, count, words, lines });
  if (result.moments.length === 0) {
    const s = result.stats;
    throw new Error(`Semua ${s.received} segmen dari AI tidak lolos validasi (terlalu pendek: ${s.tooShort}, tidak valid: ${s.invalid}, overlap: ${s.overlap}). Coba rentang durasi lain atau ganti model.`);
  }
  return result;
}

await fsp.mkdir(OUTPUT_DIR, { recursive: true });
const WORDS_DIR = path.join(OUTPUT_DIR, WORDS_DIR_NAME);
await fsp.mkdir(WORDS_DIR, { recursive: true });
const wordsFileFor = (clipFilename) => path.join(WORDS_DIR, `${path.basename(clipFilename)}.json`);

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

const parseMultipart = (req) => new Promise((resolve, reject) => {
  const busboy = Busboy({ headers: req.headers });
  const fields = {};
  let videoPath = null;
  let videoName = 'video.mp4';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-clipper-'));

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

// Settings sent by the browser, clamped to sane values.
const readJobSettings = (fields) => {
  const count = clamp(Math.round(Number(fields.clip_count) || 5), 1, 10);
  let minDur = clamp(Math.round(Number(fields.min_duration) || 30), 5, 170);
  let maxDur = clamp(Math.round(Number(fields.max_duration) || 60), 10, 180);
  if (maxDur <= minDur) maxDur = minDur + 10;
  return {
    count, minDur, maxDur,
    provider: fields.provider === 'ollama' ? 'ollama' : fields.provider === 'openrouter' ? 'openrouter' : AI_PROVIDER,
    model: fields.model ? String(fields.model) : undefined,
  };
};

const processJob = async (jobId, videoPath, tempDir, fields = {}) => {
  const created = [];
  const progress = (step, detail, percent) => sendSseEvent(jobId, 'progress', { step, detail, percent });
  try {
    const settings = readJobSettings(fields);
    progress('Membaca video', 'Mengecek durasi...', 2);
    const duration = await probeDuration(videoPath);
    if (!duration) throw new Error('Durasi video tidak terbaca. Pastikan file video valid.');

    // Phase 1: transcript of the whole video, so the AI picks from real content.
    let words = [];
    let lines = [];
    let notice = '';
    if (GROQ_API_KEY) {
      progress('Transkripsi audio', 'Mengirim audio ke Groq Whisper...', 5);
      try {
        ({ words, lines } = await transcribeFullVideo(videoPath, tempDir, duration, (done, total) => {
          progress('Transkripsi audio', `Bagian ${done} / ${total} selesai`, Math.round(5 + (done / total) * 25));
        }));
        if (words.length === 0) notice = 'Tidak ada ucapan yang terdeteksi, jadi AI hanya melihat durasi video.';
      } catch (error) {
        console.error('Full transcription failed:', error.message);
        notice = `Transkripsi gagal (${error.message.slice(0, 120)}), jadi AI hanya melihat durasi video.`;
        words = [];
        lines = [];
      }
    } else {
      notice = 'GROQ_API_KEY belum diset, jadi AI hanya melihat durasi video, bukan isinya.';
    }

    // Phase 2: AI picks segments, the backend validates them.
    const transcript = lines.length ? formatTranscript(lines) : '';
    const aiName = settings.provider === 'ollama' ? `Ollama${settings.model ? ` · ${settings.model}` : ''}` : 'OpenRouter';
    progress(`Analisis AI (${aiName})`, transcript ? `Membaca transkrip ${words.length} kata...` : 'Mencari segmen viral...', 32);
    const { moments, stats } = await findMoments({ ...settings, duration, transcript, words, lines });
    progress('Analisis AI', `${moments.length} segmen dipilih dari ${stats.received} kandidat`, 40);

    // Phase 3: cut the clips.
    const totalClips = moments.length;
    for (let i = 0; i < moments.length; i++) {
      const moment = moments[i];
      const clipDuration = moment.duration;

      sendSseEvent(jobId, 'progress', {
        step: `Clip ${i + 1} / ${totalClips}: ${moment.title}`,
        detail: 'Memotong clip...',
        percent: Math.round(40 + (i / totalClips) * 58),
      });

      const outputFile = `plain_${sanitizeName(moment.title)}_${moment.id}_${Date.now()}.mp4`;
      const outputPath = path.join(OUTPUT_DIR, outputFile);

      // Default: center crop
      let vf = 'crop=ih*(9/16):ih:(iw-ow)/2:0';

      // Only attempt face detection if not explicitly disabled by client.
      // Any failure here (frame grab or Python) falls back to the center crop.
      if (!fields || fields.face_detection !== '0') {
        try {
          const framePath = path.join(tempDir, `frame_${moment.id}.jpg`);
          const sampleSec = Math.max(0, Math.min(moment.start + 1, moment.start + Math.max(0.5, Math.floor(clipDuration / 2))));
          await runCommand('ffmpeg', ['-y', '-ss', String(sampleSec), '-i', videoPath, '-vframes', '1', '-q:v', '2', framePath]);
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
        const overall = Math.round(40 + ((i + clipPct) / totalClips) * 58);
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
        start: moment.start,
        end: moment.end,
        viralScore: moment.viralScore,
        reason: moment.reason,
      });

      // Keep word timing so the subtitle step needs no second transcription.
      if (moment.words.length) {
        await fsp.writeFile(wordsFileFor(outputFile), JSON.stringify(moment.words), 'utf-8');
      }
    }

    const result = {
      ok: true, clips: created, mode: 'system-ffmpeg',
      analysis: { source: words.length ? 'transcript' : 'duration', words: words.length, notice, stats },
    };
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
    const storedWords = await fsp.readFile(wordsFileFor(inputPath), 'utf-8').then(JSON.parse).catch(() => null);
    if (Array.isArray(storedWords) && storedWords.length) {
      finalCaptions = wordsToCaptions(storedWords);
    } else if (GROQ_API_KEY) {
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

  if (req.method === 'GET' && req.url === '/api/ai-providers') {
    const models = await listOllamaModels();
    sendJson(res, 200, {
      ok: true,
      default: AI_PROVIDER,
      openrouter: { available: Boolean(OPENROUTER_API_KEY), model: OPENROUTER_MODEL },
      ollama: {
        available: models !== null && models.length > 0,
        running: models !== null,
        models: models || [],
        defaultModel: models?.includes(OLLAMA_MODEL) ? OLLAMA_MODEL : (models?.[0] || ''),
      },
    });
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

      const jobId = `job_${++jobCounter}_${Date.now()}`;

      jobResults.set(jobId, null); // mark as in-progress
      processJob(jobId, videoPath, tempDir, fields);
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

// Bind to loopback only so other devices on the network cannot use the server (and its API keys).
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Open Clipper Pro server running on http://localhost:${PORT}`);
});