import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream';
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

async function callOpenRouter(messages, { temperature } = {}) {
  if (!OPENROUTER_API_KEY) throw httpError(500, 'OPENROUTER_API_KEY belum diset di .env server. Pakai mode Ollama atau isi key-nya.');
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENROUTER_API_KEY}` },
    body: JSON.stringify({
      model: OPENROUTER_MODEL, messages, response_format: { type: 'json_object' },
      ...(temperature !== undefined ? { temperature } : {}),
    }),
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
  const required = ['start', 'end', 'title', 'viral_score', 'reason', 'hook_text'];
  const properties = {
    start: { type: 'number' }, end: { type: 'number' }, title: { type: 'string' },
    viral_score: { type: 'integer' }, reason: { type: 'string' }, hook_text: { type: 'string' },
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

async function callOllama(messages, requestedModel, { schema, numCtx, temperature = 0.4 } = {}) {
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
        options: { temperature, ...(numCtx ? { num_ctx: numCtx } : {}) },
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

// --- AI direction: free-text steering from the user -------------------------

const MAX_DIRECTION_CHARS = 1000;

// The direction is embedded in the prompt inside a """ fence, so strip anything
// that could close that fence and speak as the prompt.
const sanitizeDirection = (text) => String(text || '')
  .replace(/"{3,}/g, '"')
  .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
  .trim()
  .slice(0, MAX_DIRECTION_CHARS);

// "2:00 - 2:50", "dari 21:30 sampai 22:25", "1:05:00 s/d 1:06:30". Only pairs of
// clock times count, so prose like "60-120 detik" cannot match.
const CLOCK = String.raw`(\d{1,2}:\d{2}(?::\d{2})?)`;
const TIME_RANGE_RE = new RegExp(`${CLOCK}\\s*(?:-|–|—|s/d|sd|sampai|hingga|ke|to|until)\\s*${CLOCK}`, 'gi');
const clockToSeconds = (value) => {
  const parts = value.split(':').map(Number);
  return parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0] * 3600 + parts[1] * 60 + parts[2];
};
const formatClock = (seconds) => {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

// Exact time ranges the user spelled out, clamped to the video.
const parseRequestedRanges = (direction, duration) => {
  const ranges = [];
  for (const match of direction.matchAll(TIME_RANGE_RE)) {
    const start = clockToSeconds(match[1]);
    const end = Math.min(duration, clockToSeconds(match[2]));
    if (start < duration && end - start >= 1) ranges.push({ start, end });
  }
  return ranges;
};

// Models snap to transcript line boundaries, so an exact match would rarely hold.
const RANGE_TOLERANCE = 8;
const matchesRange = (start, end, range) =>
  Math.abs(start - range.start) <= RANGE_TOLERANCE && Math.abs(end - range.end) <= RANGE_TOLERANCE;

const directionBlock = (direction, requestCount) => (direction ? `
USER DIRECTION (highest priority; it overrides the picking rules above):
"""
${direction}
"""
- If it names an exact time range such as "2:00 - 2:50", return exactly that range as one segment, even if its length is outside the usual window.
- If it asks for a topic or a kind of moment, prefer segments that match it.
- If it rules something out, leave it out.
- Still return ${requestCount} segments in total: any requested ranges plus the best other segments that fit the direction.
` : '');

const buildTranscriptPrompt = ({ duration, requestCount, minDur, maxDur, direction }) => `You are a top-tier short-form video editor cutting viral clips for TikTok, Instagram Reels and YouTube Shorts.

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
- "hook_text": 3-8 punchy words shown on screen during the first seconds to stop the scroll. No emoji, no hashtags.
- LANGUAGE: write "title", "reason" and "hook_text" in the SAME language as the transcript. An Indonesian transcript gets Indonesian text. Use English only if the transcript itself is English.
${directionBlock(direction, requestCount)}
Output ONLY JSON, no prose:
{"moments":[{"start":12.4,"end":58.9,"title":"...","viral_score":87,"reason":"...","hook_text":"..."}]}`;

// Used when no transcript is available: the AI only knows the duration.
const buildMetadataPrompt = ({ duration, requestCount, minDur, maxDur, direction }) => `Anda adalah ahli editor video viral profesional.
Video berdurasi ${Math.round(duration)} detik. Temukan ${requestCount} segmen terbaik untuk clip viral vertikal (Reels/TikTok/Shorts).
ATURAN:
- start dan end dalam detik, rentang 0-${Math.round(duration)}
- Durasi tiap segmen ${minDur}-${maxDur} detik, TIDAK overlap
- Setiap segmen WAJIB punya "viral_score" (1-100), "reason" (satu kalimat), dan "hook_text" (3-8 kata pembuka yang bikin berhenti scroll)
- Setiap segmen WAJIB punya array 'captions' (4-6 caption per segmen, maks 8 kata per caption)
- Caption: text, start_offset, end_offset (relatif dari start segmen, detik)
- Urutkan dari viral_score tertinggi ke terendah
${directionBlock(direction, requestCount)}
Format JSON MURNI:
{"moments":[{"start":0,"end":20,"title":"Hook Awal","viral_score":85,"reason":"...","hook_text":"...","captions":[{"text":"INI DIA RAHASIANYA","start_offset":0,"end_offset":4}]}]}`;

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
// Move a cut onto word boundaries so clips never start or end mid-word, then
// pad into the surrounding silence (never into the neighbouring words) so the
// first and last sentence are not clipped.
const LEAD_IN = 0.6;
const TAIL_OUT = 1.2;
const SILENCE_GAP = 0.05;
const snapToWords = (start, end, words, duration) => {
  const firstIndex = words.findIndex(w => w.end > start);
  let lastIndex = -1;
  for (let i = 0; i < words.length; i++) {
    if (words[i].start < end) lastIndex = i;
    else break;
  }
  if (firstIndex === -1 || lastIndex < firstIndex) return { start, end };
  const first = words[firstIndex];
  const last = words[lastIndex];
  const previousEnd = firstIndex > 0 ? words[firstIndex - 1].end + SILENCE_GAP : 0;
  const nextStart = lastIndex + 1 < words.length ? words[lastIndex + 1].start - SILENCE_GAP : duration;
  return {
    start: Math.max(0, Math.min(first.start, Math.max(first.start - LEAD_IN, previousEnd))),
    end: Math.min(duration, Math.max(last.end, Math.min(last.end + TAIL_OUT, nextStart))),
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

// Turn raw AI moments into review candidates: clamp, snap, enforce the
// duration window, drop overlaps, honour exact ranges from the direction.
// The best `count` are preselected; the rest stay as alternatives.
const DURATION_TOLERANCE = 3;
const validateMoments = (rawMoments, { duration, minDur, maxDur, count, maxCandidates, words, lines = [], ranges = [] }) => {
  const stats = { received: rawMoments.length, tooShort: 0, extended: 0, trimmed: 0, overlap: 0, invalid: 0, requested: 0 };
  const candidates = [];
  const matchedRanges = new Set();

  for (const m of rawMoments) {
    let start = Number(m.start);
    let end = Number(m.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) { stats.invalid++; continue; }
    start = clamp(start, 0, duration);
    end = clamp(end, 0, duration);
    if (end <= start) { stats.invalid++; continue; }

    const rangeIndex = ranges.findIndex(r => matchesRange(start, end, r));
    const requested = rangeIndex !== -1 && !matchedRanges.has(rangeIndex);
    if (requested) {
      // The user asked for this exact span: use it as written, skip the duration window.
      matchedRanges.add(rangeIndex);
      ({ start, end } = ranges[rangeIndex]);
    } else {
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
    }

    candidates.push({
      start, end, requested,
      title: String(m.title || '').trim().slice(0, 80) || 'Clip viral',
      reason: String(m.reason || '').trim().slice(0, 240),
      hookText: String(m.hook_text || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      viralScore: clamp(Math.round(Number(m.viral_score) || 50), 1, 100),
      aiCaptions: (Array.isArray(m.captions) ? m.captions : []).map(c => String(c?.text || '').trim()).filter(Boolean).slice(0, 12),
    });
  }

  // A range the AI ignored is still what the user asked for: add it directly.
  ranges.forEach((range, index) => {
    if (matchedRanges.has(index)) return;
    candidates.push({
      start: range.start, end: range.end, requested: true,
      title: `Bagian ${formatClock(range.start)}–${formatClock(range.end)}`,
      reason: 'Diminta lewat AI direction.', hookText: '', viralScore: 100, aiCaptions: [],
    });
  });
  stats.requested = ranges.length;

  // Requested spans first, in the order they were asked for; then by score.
  candidates.sort((a, b) => (Number(b.requested) - Number(a.requested)) || (a.requested ? 0 : b.viralScore - a.viralScore));
  const picked = [];
  for (const c of candidates) {
    if (!c.requested && picked.some(p => c.start < p.end - 1 && c.end > p.start + 1)) { stats.overlap++; continue; }
    picked.push(c);
    if (picked.length >= Math.max(maxCandidates, ranges.length)) break;
  }

  const preselect = Math.max(count, ranges.length);
  const result = picked.map((c, index) => ({
    id: index + 1,
    title: c.title, reason: c.reason, hookText: c.hookText, viralScore: c.viralScore,
    start: Number(c.start.toFixed(2)), end: Number(c.end.toFixed(2)),
    requested: c.requested, selected: index < preselect, aiCaptions: c.aiCaptions,
  }));
  return { candidates: result, stats };
};

// Subtitle captions for a span: word timing when there is a transcript,
// otherwise the AI's caption ideas spread evenly, otherwise the title.
const captionsForSpan = (session, candidate, start, end) => {
  const clipDuration = end - start;
  const clipWords = session.words.length ? wordsInRange(session.words, start, end) : [];
  if (clipWords.length) return { captions: wordsToCaptions(clipWords), words: clipWords };
  const texts = candidate?.aiCaptions?.length ? candidate.aiCaptions : [candidate?.title || 'Clip viral'];
  const slot = clipDuration / texts.length;
  return {
    captions: texts.map((text, i) => ({
      text,
      start_offset: Number((i * slot).toFixed(2)),
      end_offset: Number(((i + 1) * slot - 0.05).toFixed(2)),
    })),
    words: [],
  };
};

async function findMoments({ provider, model, duration, transcript, count, minDur, maxDur, words, lines, direction }) {
  const requestCount = Math.min(15, count + 3); // over-request, then filter
  const settings = { duration, requestCount, minDur, maxDur, direction };
  // With a direction, adherence matters more than variety, so sample colder.
  const temperature = direction ? 0.2 : undefined;
  const reminder = direction ? `\n\nREMINDER, user direction (highest priority): ${direction}` : '';
  const messages = transcript
    ? [
        { role: 'system', content: buildTranscriptPrompt(settings) },
        { role: 'user', content: `TRANSCRIPT:\n${transcript}${reminder}` },
      ]
    : [
        { role: 'system', content: buildMetadataPrompt(settings) },
        { role: 'user', content: `Temukan ${requestCount} segmen paling viral dari video berdurasi ${Math.round(duration)} detik.${reminder}` },
      ];

  let content;
  if (provider === 'ollama') {
    // Ollama silently drops the start of a prompt longer than num_ctx, so size it to the transcript.
    const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
    const numCtx = clamp(Math.ceil(promptChars / 3) + 4096, 8192, 32768);
    content = await callOllama(messages, model, { schema: momentsSchema(requestCount, !transcript), numCtx, temperature: temperature ?? 0.4 });
  } else {
    content = await callOpenRouter(messages, { temperature });
  }

  const ranges = direction ? parseRequestedRanges(direction, duration) : [];
  const raw = parseMomentsJson(content);
  if (raw.length === 0 && ranges.length === 0) throw new Error('AI tidak mengembalikan segmen yang bisa dibaca. Coba lagi atau ganti model.');
  const result = validateMoments(raw, { duration, minDur, maxDur, count, maxCandidates: requestCount, words, lines, ranges });
  if (result.candidates.length === 0) {
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
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
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
const subtitleAssHeader = (subtitleSize, subtitleY, videoWidth = 1080, videoHeight = 1920) => {
  const fontSize = Math.max(20, Math.round(Number(subtitleSize || 22) * 3));
  const outlineSize = Math.max(2, Math.round(fontSize / 14));
  const shadowSize = 1;
  const marginH = 60; // horizontal margin (left + right) in pixels — prevents edge overflow
  
  // ASS Alignment: 2 = bottom-center (default)
  // We use MarginV to shift vertically. subtitleY: 0=bottom, 100=top
  const yRatio = Math.max(0, Math.min(100, Number(subtitleY ?? 0))) / 100;
  // MarginV from bottom: 0% → small margin (40px), 100% → near top
  const marginV = Math.round(40 + yRatio * (videoHeight - fontSize * 2 - 80));
  
  return `[Script Info]
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
`;
};

const generateAssFile = async (captions, subtitleSize, subtitleY, outputAssPath) => {
  const events = captions.map(c => {
    const text = escapeAssText(c.text || '').toUpperCase();
    return `Dialogue: 0,${toAssTime(c.start_offset)},${toAssTime(c.end_offset)},Default,,0,0,0,,${text}`;
  });
  await fsp.writeFile(outputAssPath, subtitleAssHeader(subtitleSize, subtitleY) + events.join('\n') + '\n', 'utf-8');
  return outputAssPath;
};

// Karaoke captions: short lines where the word being spoken is highlighted.
// One event per word, each showing the whole line with that word in yellow.
const KARAOKE_WORDS_PER_LINE = 3;
const KARAOKE_LINE_GAP = 0.7; // a pause longer than this starts a new line
const KARAOKE_HIGHLIGHT = '&H0000E5FF&'; // ASS colours are BGR: warm yellow
const generateKaraokeAssFile = async (words, subtitleSize, subtitleY, outputAssPath) => {
  const lines = [];
  let line = [];
  for (const w of words) {
    const previous = line[line.length - 1];
    if (line.length >= KARAOKE_WORDS_PER_LINE || (previous && w.start - previous.end > KARAOKE_LINE_GAP)) {
      lines.push(line);
      line = [];
    }
    line.push(w);
  }
  if (line.length) lines.push(line);

  const events = [];
  let previousEnd = 0;
  lines.forEach((lineWords, lineIndex) => {
    const nextLineStart = lines[lineIndex + 1]?.[0].start ?? Infinity;
    const texts = lineWords.map(w => escapeAssText(w.word).toUpperCase());
    lineWords.forEach((w, j) => {
      const start = Math.max(w.start, previousEnd);
      // Hold each state until the next word starts; hold the last word briefly.
      const until = j + 1 < lineWords.length ? lineWords[j + 1].start : Math.min(w.end + 0.4, nextLineStart);
      const end = Math.max(until, start + 0.08);
      const text = texts.map((t, k) => (k === j ? `{\\c${KARAOKE_HIGHLIGHT}}${t}{\\c&HFFFFFF&}` : t)).join(' ');
      events.push(`Dialogue: 0,${toAssTime(start)},${toAssTime(end)},Default,,0,0,0,,${text}`);
      previousEnd = end;
    });
  });
  await fsp.writeFile(outputAssPath, subtitleAssHeader(subtitleSize, subtitleY) + events.join('\n') + '\n', 'utf-8');
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

const parseMultipart = (req, targetDir) => new Promise((resolve, reject) => {
  const busboy = Busboy({ headers: req.headers });
  const fields = {};
  let videoPath = null;
  let videoName = 'video.mp4';
  let writeDone = Promise.resolve();
  const tempDir = targetDir || fs.mkdtempSync(path.join(os.tmpdir(), 'open-clipper-'));

  busboy.on('field', (name, value) => {
    fields[name] = value;
  });

  busboy.on('file', (name, file, info) => {
    if (name !== 'video') {
      file.resume();
      return;
    }
    videoName = info.filename || videoName;
    const ext = path.extname(videoName).toLowerCase();
    videoPath = path.join(tempDir, 'source' + (/^\.[a-z0-9]{1,5}$/.test(ext) ? ext : '.mp4'));
    const stream = fs.createWriteStream(videoPath);
    writeDone = new Promise((done, fail) => { stream.on('finish', done); stream.on('error', fail); });
    file.pipe(stream);
    stream.on('error', reject);
  });

  busboy.on('finish', () => {
    // Wait for the file to be flushed to disk before anyone reads it.
    writeDone.then(() => resolve({ fields, videoPath, tempDir, videoName }), reject);
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

// ---------------------------------------------------------------------------
// Sessions: one folder per uploaded video, kept so the user can review,
// re-analyze and re-render without uploading or transcribing again.
// ---------------------------------------------------------------------------

const SESSIONS_DIR = path.join(OUTPUT_DIR, '.sessions');
await fsp.mkdir(SESSIONS_DIR, { recursive: true });
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const busySessions = new Set();

// Leftovers from a crash, an interrupted upload, or a delete while the video
// was still open (FUSE keeps the file until the handle closes): no session.json.
for (const entry of await fsp.readdir(SESSIONS_DIR, { withFileTypes: true }).catch(() => [])) {
  if (!entry.isDirectory()) continue;
  const dir = path.join(SESSIONS_DIR, entry.name);
  if (!(await fileExists(path.join(dir, 'session.json')))) await removeDirSafe(dir);
}

const sessionDir = (id) => path.join(SESSIONS_DIR, id);
const sessionFile = (id) => path.join(sessionDir(id), 'session.json');

const loadSession = async (id) => {
  if (!SESSION_ID_RE.test(id)) throw httpError(404, 'Session tidak ditemukan.');
  try {
    return JSON.parse(await fsp.readFile(sessionFile(id), 'utf-8'));
  } catch {
    throw httpError(404, 'Session tidak ditemukan.');
  }
};

const saveSession = async (session) => {
  session.updatedAt = Date.now();
  const file = sessionFile(session.id);
  await fsp.writeFile(`${file}.tmp`, JSON.stringify(session), 'utf-8');
  await fsp.rename(`${file}.tmp`, file);
};

// What the browser gets: everything except the raw transcript.
const publicSession = (session) => ({
  id: session.id,
  name: session.name,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  duration: session.duration,
  videoUrl: `/api/sessions/${session.id}/video`,
  transcriptWords: session.words.length,
  settings: session.settings,
  analysis: session.analysis,
  candidates: session.candidates,
  clips: session.clips,
});

const sessionSummary = (session) => ({
  id: session.id,
  name: session.name,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  duration: session.duration,
  candidates: session.candidates.length,
  clips: session.clips.length,
  source: session.analysis?.source || null,
});

// Settings sent by the browser, clamped to sane values.
const readJobSettings = (fields) => {
  const count = clamp(Math.round(Number(fields.clip_count) || 5), 1, 10);
  const minDur = clamp(Math.round(Number(fields.min_duration) || 30), 5, 170);
  let maxDur = clamp(Math.round(Number(fields.max_duration) || 60), 10, 180);
  if (maxDur <= minDur) maxDur = minDur + 10;
  return {
    count, minDur, maxDur,
    provider: fields.provider === 'ollama' ? 'ollama' : fields.provider === 'openrouter' ? 'openrouter' : AI_PROVIDER,
    model: fields.model ? String(fields.model) : undefined,
    direction: sanitizeDirection(fields.direction),
  };
};

const finishJob = (jobId, result) => {
  jobResults.set(jobId, result);
  sendSseEvent(jobId, 'done', result);
  const client = sseClients.get(jobId);
  if (client && !client.closed) client.res.end();
  sseClients.delete(jobId);
};

// Runs a job body for a session, one job per session at a time.
const startSessionJob = (session, prefix, body) => {
  if (busySessions.has(session.id)) throw httpError(409, 'Session ini masih memproses job lain. Tunggu sampai selesai.');
  busySessions.add(session.id);
  const jobId = `${prefix}_${++jobCounter}_${Date.now()}`;
  jobResults.set(jobId, null); // mark as in-progress
  const progress = (step, detail, percent) => sendSseEvent(jobId, 'progress', { step, detail, percent });
  (async () => {
    const tempDir = await fsp.mkdtemp(path.join(sessionDir(session.id), 'tmp-'));
    try {
      finishJob(jobId, { ok: true, ...(await body(progress, tempDir)) });
    } catch (error) {
      console.error(`${prefix} job failed:`, error.message);
      finishJob(jobId, { ok: false, error: error.message || 'Processing gagal.' });
    } finally {
      busySessions.delete(session.id);
      await removeDirSafe(tempDir);
    }
  })();
  return jobId;
};

// Phase 1 (once per video): transcript of the whole video.
const transcribeSession = async (session, videoPath, tempDir, progress) => {
  session.words = [];
  session.lines = [];
  session.transcriptNotice = '';
  if (!GROQ_API_KEY) {
    session.transcriptNotice = 'GROQ_API_KEY belum diset, jadi AI hanya melihat durasi video, bukan isinya.';
    return;
  }
  progress('Transkripsi audio', 'Mengirim audio ke Groq Whisper...', 5);
  try {
    const { words, lines } = await transcribeFullVideo(videoPath, tempDir, session.duration, (done, total) => {
      progress('Transkripsi audio', `Bagian ${done} / ${total} selesai`, Math.round(5 + (done / total) * 55));
    });
    session.words = words;
    session.lines = lines;
    if (words.length === 0) session.transcriptNotice = 'Tidak ada ucapan yang terdeteksi, jadi AI hanya melihat durasi video.';
  } catch (error) {
    console.error('Full transcription failed:', error.message);
    session.transcriptNotice = `Transkripsi gagal (${error.message.slice(0, 120)}), jadi AI hanya melihat durasi video.`;
  }
};

// Phase 2: the AI proposes candidates for the user to review. Nothing is rendered yet.
const analyzeSession = async (session, settings, { transcribe }, progress, tempDir) => {
  const videoPath = path.join(sessionDir(session.id), session.videoFile);
  if (transcribe) {
    progress('Membaca video', 'Mengecek durasi...', 2);
    session.duration = await probeDuration(videoPath);
    if (!session.duration) throw new Error('Durasi video tidak terbaca. Pastikan file video valid.');
    await transcribeSession(session, videoPath, tempDir, progress);
    await saveSession(session);
  }

  const transcript = session.lines.length ? formatTranscript(session.lines) : '';
  const aiName = settings.provider === 'ollama' ? `Ollama${settings.model ? ` · ${settings.model}` : ''}` : 'OpenRouter';
  progress(`Analisis AI (${aiName})`, transcript ? `Membaca transkrip ${session.words.length} kata...` : 'Mencari segmen viral...', 65);
  const { candidates, stats } = await findMoments({
    ...settings, duration: session.duration, transcript, words: session.words, lines: session.lines,
  });

  session.settings = settings;
  session.candidates = candidates;
  session.analysis = {
    source: session.words.length ? 'transcript' : 'duration',
    words: session.words.length,
    notice: session.transcriptNotice || '',
    stats,
    provider: aiName,
    analyzedAt: Date.now(),
  };
  await saveSession(session);
  progress('Analisis AI', `${candidates.length} kandidat siap dipilih`, 100);
  return { session: publicSession(session) };
};

// ---------------------------------------------------------------------------
// Reframing to 9:16
// ---------------------------------------------------------------------------

const PYTHON_BIN = process.env.PYTHON_BIN || 'python';
const REFRAME_MODES = ['track', 'center', 'blur', 'black'];
const CENTER_CROP = 'crop=ih*(9/16):ih:(iw-ow)/2:0';
const ffmpegFilePath = (filePath) => filePath.replace(/\\/g, '/').replace(/:/g, '\\:');

// Follow the main face through the clip. face_track.py returns one crop x per
// frame; sendcmd feeds them to the crop filter as the clip plays.
const faceTrackFilter = async (videoPath, start, clipDuration, tempDir, index) => {
  const { stdout } = await runCommand(PYTHON_BIN, [
    path.join(ROOT_DIR, 'server', 'face_track.py'), videoPath, String(start), String(clipDuration),
  ]);
  const track = JSON.parse(stdout.trim().split('\n').pop() || '{}');
  if (track.error) throw new Error(track.error);
  if (!track.x?.length || track.faces_found === 0) return { filter: CENTER_CROP, note: 'tidak ada wajah, crop tengah' };

  const lines = [];
  let previous = null;
  track.x.forEach((x, frame) => {
    if (x === previous) return;
    lines.push(`${(frame / track.fps).toFixed(3)} crop x ${x};`);
    previous = x;
  });
  const cmdPath = path.join(tempDir, `track_${index}.cmd`);
  await fsp.writeFile(cmdPath, lines.join('\n') + '\n', 'utf-8');
  return {
    filter: `sendcmd=f='${ffmpegFilePath(cmdPath)}',crop=${track.crop_w}:${track.height}:${track.x[0]}:0`,
    note: `${track.detector}, wajah di ${track.faces_found}/${track.samples} sampel`,
  };
};

// Video filter for the chosen reframe mode. Tracking falls back to a center
// crop when Python, OpenCV or MediaPipe is unavailable.
const reframeFilter = async (mode, videoPath, start, clipDuration, tempDir, index) => {
  if (mode === 'blur') {
    // Blur a small copy for the background (much cheaper than blurring 1080x1920).
    return {
      filter: 'split=2[bg][fg];'
        + '[bg]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=10:2,scale=1080:1920[bgb];'
        + '[fg]scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2[fgs];'
        + '[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1',
      note: '',
    };
  }
  if (mode === 'black') {
    return {
      filter: 'scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1',
      note: '',
    };
  }
  if (mode === 'track') {
    try {
      return await faceTrackFilter(videoPath, start, clipDuration, tempDir, index);
    } catch (error) {
      console.error('Face tracking failed, using center crop:', error.message.slice(0, 300));
      return { filter: CENTER_CROP, note: 'face tracking gagal, crop tengah' };
    }
  }
  return { filter: CENTER_CROP, note: '' };
};

// Hook text: a boxed line near the top for the first seconds of the clip.
// The script is authored at 1080x1920; libass scales it to the 9:16 frame.
const HOOK_SECONDS = 4;
const writeHookAss = async (text, assPath, clipDuration) => {
  const end = Math.min(HOOK_SECONDS, clipDuration);
  const content = `[Script Info]
Title: Hook
ScriptType: v4.00+
WrapStyle: 0
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Hook,Arial,74,&H00111111,&H000000FF,&H00FFFFFF,&H00FFFFFF,-1,0,0,0,100,100,0,0,3,20,0,8,110,110,500,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,${toAssTime(0)},${toAssTime(end)},Hook,,0,0,0,,{\\fad(120,250)}${escapeAssText(text.replace(/\s+/g, ' ').trim())}
`;
  await fsp.writeFile(assPath, content, 'utf-8');
};


// Phase 3: render the spans the user picked (with their edits).
const renderSession = async (session, items, options, progress, tempDir) => {
  const videoPath = path.join(sessionDir(session.id), session.videoFile);
  const created = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const candidate = session.candidates.find(c => c.id === item.id);
    const start = Number(item.start);
    const end = Number(item.end);
    const clipDuration = Number((end - start).toFixed(2));
    const title = String(item.title || candidate?.title || `Clip ${i + 1}`).trim().slice(0, 80);
    const hookText = options.hook ? String(item.hookText ?? candidate?.hookText ?? '').trim().slice(0, 80) : '';
    const step = `Clip ${i + 1} / ${items.length}: ${title}`;
    progress(step, 'Memotong clip...', Math.round((i / items.length) * 98));

    const outputFile = `plain_${sanitizeName(title)}_${i + 1}_${Date.now()}.mp4`;
    const outputPath = path.join(OUTPUT_DIR, outputFile);
    progress(step, options.reframe === 'track' ? 'Melacak wajah...' : 'Memotong clip...', Math.round((i / items.length) * 98));
    const reframe = await reframeFilter(options.reframe, videoPath, start, clipDuration, tempDir, i);
    let vf = reframe.filter;
    if (hookText) {
      const assPath = path.join(tempDir, `hook_${i}.ass`);
      await writeHookAss(hookText, assPath, clipDuration);
      vf += `,ass='${ffmpegFilePath(assPath)}'`;
    }

    await runCommandWithProgress('ffmpeg', [
      '-y', '-ss', String(start), '-i', videoPath, '-t', String(clipDuration),
      '-vf', vf,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
      '-progress', 'pipe:1', outputPath,
    ], {}, (processedSeconds) => {
      const clipPct = Math.min(1, processedSeconds / Math.max(clipDuration, 0.1));
      progress(step, `${Math.round(clipPct * 100)}% selesai`, Math.round(((i + clipPct) / items.length) * 98));
    });

    // Keep word timing so the subtitle step needs no second transcription.
    const { captions, words } = captionsForSpan(session, candidate, start, end);
    if (words.length) await fsp.writeFile(wordsFileFor(outputFile), JSON.stringify(words), 'utf-8');

    const clip = {
      id: `${Date.now().toString(36)}${i}`,
      candidateId: candidate?.id ?? null,
      title, hookText,
      reframe: options.reframe,
      reframeNote: reframe.note,
      reason: candidate?.reason || '',
      viralScore: candidate?.viralScore ?? null,
      start, end, duration: clipDuration,
      filename: outputFile,
      url: `/outputs/${encodeURIComponent(outputFile)}`,
      captions,
      subtitledFilename: null,
      subtitledUrl: null,
      createdAt: Date.now(),
    };
    created.push(clip);
    session.clips.push(clip);
    await saveSession(session);
  }
  return { clips: created, session: publicSession(session) };
};

// Validate the render request against the session before starting a job.
const readRenderItems = (session, body) => {
  const items = Array.isArray(body.items) ? body.items.slice(0, 15) : [];
  if (items.length === 0) throw httpError(400, 'Pilih minimal satu highlight untuk dirender.');
  return items.map((item, index) => {
    const start = Number(item.start);
    const end = Number(item.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > session.duration + 0.5 || end - start < 1) {
      throw httpError(400, `Highlight ${index + 1}: waktu mulai/selesai tidak valid.`);
    }
    if (end - start > 300) throw httpError(400, `Highlight ${index + 1}: maksimal 5 menit per clip.`);
    return {
      id: Number(item.id) || null,
      start: Number(start.toFixed(2)),
      end: Number(Math.min(end, session.duration).toFixed(2)),
      title: typeof item.title === 'string' ? item.title : undefined,
      hookText: typeof item.hookText === 'string' ? item.hookText : undefined,
    };
  });
};

const deleteSession = async (session) => {
  for (const clip of session.clips) {
    for (const name of [clip.filename, clip.subtitledFilename]) {
      if (!name) continue;
      await fsp.unlink(path.join(OUTPUT_DIR, path.basename(name))).catch(() => {});
    }
    await fsp.unlink(wordsFileFor(clip.filename)).catch(() => {});
  }
  await removeDirSafe(sessionDir(session.id));
};

const listSessions = async () => {
  const entries = await fsp.readdir(SESSIONS_DIR, { withFileTypes: true }).catch(() => []);
  const sessions = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SESSION_ID_RE.test(entry.name)) continue;
    try {
      sessions.push(sessionSummary(await loadSession(entry.name)));
    } catch { /* half-written or corrupt session: skip */ }
  }
  return sessions.sort((a, b) => b.createdAt - a.createdAt);
};

const readJsonBody = (req, limit = 1024 * 1024) => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', chunk => {
    body += chunk.toString();
    if (body.length > limit) {
      reject(httpError(413, 'Request terlalu besar.'));
      req.destroy();
    }
  });
  req.on('end', () => {
    try {
      resolve(body ? JSON.parse(body) : {});
    } catch {
      reject(httpError(400, 'JSON tidak valid.'));
    }
  });
  req.on('error', reject);
});

const VIDEO_TYPES = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo' };

// Serve a file with HTTP Range support, which <video> needs for seeking.
// pipeline() closes the file when the browser aborts a request (it does that
// constantly while seeking); a bare pipe() would keep the handle open.
const streamFile = async (req, res, filePath) => {
  const { size } = await fsp.stat(filePath);
  const type = VIDEO_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (match && (match[1] || match[2])) {
    const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      'Content-Type': type, 'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1,
    });
    pipeline(fs.createReadStream(filePath, { start, end }), res, () => {});
    return;
  }
  res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size });
  pipeline(fs.createReadStream(filePath), res, () => {});
};

const addSubtitleJob = async (jobId, inputPath, captions, subtitleSize, subtitleY, clipDuration, onSuccess, style = 'karaoke') => {
  let assPath = null;
  try {
    // Step 1: Transcribe actual audio if Groq API key is available
    let finalCaptions = captions;
    const storedWords = await fsp.readFile(wordsFileFor(inputPath), 'utf-8').then(JSON.parse).catch(() => null);
    const hasWords = Array.isArray(storedWords) && storedWords.length > 0;
    if (hasWords) {
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
    // Karaoke needs real word timing; AI-written captions fall back to plain lines.
    if (style === 'karaoke' && hasWords) await generateKaraokeAssFile(storedWords, subtitleSize, subtitleY, assPath);
    else await generateAssFile(timedCaptions, subtitleSize, subtitleY, assPath);

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
    await onSuccess?.(result).catch(err => console.error('Could not record subtitle in session:', err.message));
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
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const { pathname } = new URL(req.url || '/', 'http://localhost');

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
    pipeline(fs.createReadStream(filePath), res, () => {});
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

  // Upload a video: creates a session, transcribes it and asks the AI for candidates.
  if (req.method === 'POST' && pathname === '/api/sessions') {
    const id = crypto.randomUUID();
    const dir = sessionDir(id);
    try {
      await fsp.mkdir(dir, { recursive: true });
      const { fields, videoPath, videoName } = await parseMultipart(req, dir);
      if (!videoPath || !(await fileExists(videoPath))) throw httpError(400, 'Video file tidak ditemukan di request.');
      const session = {
        id, name: String(videoName || 'video').slice(0, 200), createdAt: Date.now(), updatedAt: Date.now(),
        videoFile: path.basename(videoPath), duration: 0,
        words: [], lines: [], transcriptNotice: '',
        settings: null, analysis: null, candidates: [], clips: [],
      };
      await saveSession(session);
      const settings = readJobSettings(fields);
      const jobId = startSessionJob(session, 'analyze', (progress, tempDir) =>
        analyzeSession(session, settings, { transcribe: true }, progress, tempDir));
      sendJson(res, 200, { ok: true, sessionId: id, jobId });
    } catch (error) {
      await removeDirSafe(dir);
      sendJson(res, error.statusCode || 500, { ok: false, error: error.message || 'Upload gagal.' });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/sessions') {
    sendJson(res, 200, { ok: true, sessions: await listSessions() });
    return;
  }

  const sessionRoute = /^\/api\/sessions\/([^/]+)(?:\/(analyze|render|video))?$/.exec(pathname);
  if (sessionRoute) {
    const [, id, action] = sessionRoute;
    try {
      const session = await loadSession(id);

      if (req.method === 'GET' && !action) {
        sendJson(res, 200, { ok: true, session: publicSession(session) });
      } else if (req.method === 'GET' && action === 'video') {
        await streamFile(req, res, path.join(sessionDir(id), session.videoFile));
      } else if (req.method === 'DELETE' && !action) {
        if (busySessions.has(id)) throw httpError(409, 'Session masih memproses job. Tunggu sampai selesai.');
        await deleteSession(session);
        sendJson(res, 200, { ok: true });
      } else if (req.method === 'POST' && action === 'analyze') {
        // Re-run the AI (new direction or settings) on the stored transcript.
        const settings = readJobSettings(await readJsonBody(req));
        const transcribe = !session.duration || (session.words.length === 0 && Boolean(GROQ_API_KEY));
        const jobId = startSessionJob(session, 'analyze', (progress, tempDir) =>
          analyzeSession(session, settings, { transcribe }, progress, tempDir));
        sendJson(res, 200, { ok: true, jobId });
      } else if (req.method === 'POST' && action === 'render') {
        const body = await readJsonBody(req);
        const items = readRenderItems(session, body);
        const reframe = REFRAME_MODES.includes(body.reframe) ? body.reframe : (body.faceDetection === false ? 'center' : 'track');
        const options = { reframe, hook: body.hook === true };
        const jobId = startSessionJob(session, 'render', (progress, tempDir) =>
          renderSession(session, items, options, progress, tempDir));
        sendJson(res, 200, { ok: true, jobId });
      } else {
        sendJson(res, 405, { ok: false, error: 'Method not allowed' });
      }
    } catch (error) {
      if (!res.headersSent) sendJson(res, error.statusCode || 500, { ok: false, error: error.message || 'Request gagal.' });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/add-subtitle') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const { clipFilename, captions, subtitleSize, subtitleY, clipDuration, sessionId, style } = JSON.parse(body);
        const safeName = path.basename(clipFilename);
        const inputPath = path.join(OUTPUT_DIR, safeName);
        if (!(await fileExists(inputPath))) {
          sendJson(res, 404, { ok: false, error: 'Clip file tidak ditemukan.' });
          return;
        }
        const jobId = `sub_${++jobCounter}_${Date.now()}`;
        jobResults.set(jobId, null);
        // Remember the subtitled file on the session so the library can show it later.
        const recordInSession = sessionId ? async (result) => {
          const session = await loadSession(String(sessionId));
          const clip = session.clips.find(c => c.filename === safeName);
          if (!clip) return;
          clip.subtitledFilename = result.filename;
          clip.subtitledUrl = result.url;
          await saveSession(session);
        } : undefined;
        addSubtitleJob(jobId, inputPath, captions || [], subtitleSize || 22, subtitleY ?? 0, clipDuration || 30, recordInSession, style === 'plain' ? 'plain' : 'karaoke');
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