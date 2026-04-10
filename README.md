# Sosmed Clipper

AI-powered local video clipper for vertical social video (Reels/TikTok/Shorts).

Features
- Detects 3–10 potentially viral segments using OpenRouter AI (Gemini).
- Cuts 9:16 vertical clips locally with FFmpeg.
- Face-centered cropping using MediaPipe (offline) for better framing.
- Transcribes audio using Groq Whisper (if API key set) and burns subtitles via ASS (word-wrap, margins).
- Per-clip subtitle size and vertical position controls.
- Real-time progress via Server-Sent Events (SSE).

Supported platforms
- Developed on Windows. Works on macOS/Linux with minor adjustments.

Prerequisites
- Node.js v18+ (LTS) installed and on PATH.
- Python 3.10 or 3.11 (64-bit) installed and on PATH.
- FFmpeg installed and on PATH (`ffmpeg` must be runnable in terminal).
- Git (optional).

Quick checks
```bash
node --version
python --version
ffmpeg -version
```

Install (frontend + backend)
1. Clone repo and enter folder:
```bash
git clone <repo-url> sosmedclipper
cd sosmedclipper
```

2. Install Node deps:
```bash
npm install
```

3. (Recommended) Create Python venv and install MediaPipe + OpenCV
PowerShell:
```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip setuptools wheel
python -m pip install -r server/requirements.txt
```
If mediapipe pip wheel fails on Windows, try conda:
```bash
conda create -n clipper python=3.10 -y
conda activate clipper
conda install -c conda-forge mediapipe opencv -y
```

Configure API keys
- OpenRouter (Gemini) — set `OPENROUTER_API_KEY` in `src/App.jsx` or export as env var.
- Groq Whisper — set `GROQ_API_KEY` as environment variable (recommended).

PowerShell example (temporary for session):
```powershell
$env:OPENROUTER_API_KEY="sk-or-..."
$env:GROQ_API_KEY="gsk_..."
```

Run backend server (local FFmpeg server + face detection)
- Start server from repo root (ensure Python venv activated so `python` invokes the MediaPipe-enabled interpreter):
```powershell
npm run dev:server
```
- Server listens on port 3030 by default. Change port with `CLIPPER_SERVER_PORT` env var.

Run frontend (Vite dev server)
```bash
npm run dev
```
- Open http://localhost:5173 in your browser. The Vite dev server proxies `/api` to the backend.

Typical workflow in the app
1. Upload a source video.
2. Adjust global subtitle preview if desired.
3. Click **JADIKAN CLIP VIRAL** — AI analyzes and returns 3–10 candidate segments with `viral_score`.
4. Preview plain clips (no subtitles). For each clip, adjust per-clip subtitle size and Y position.
5. Click **Generate Subtitle** per clip — backend will transcribe audio (Groq Whisper if key set) and burn ASS subtitles.
6. Download finished clip via **Simpan Video**.

Important files
- `server/local-ffmpeg-server.mjs` — backend server (clip cutting, subtitle burning, face-centering).
- `server/face_detect.py` — MediaPipe face detection helper (called by server).
- `server/requirements.txt` — Python deps for face detection (MediaPipe + OpenCV).
- `src/App.jsx` — React frontend (controls, AI prompt, UI).
- `vite.config.js` — Vite config + proxy.

Troubleshooting
- Face-centering not applied: ensure `python -m pip install -r server/requirements.txt` succeeded and `python` in PATH is the venv interpreter.
- mediapipe install errors: use Python 3.10/3.11 64-bit or use conda packages from conda-forge.
- FFmpeg errors about filters: use a full FFmpeg build (libfreetype/ass support) — download static builds from gyan.dev or ffmpeg.org.
- Whisper/Groq errors: confirm `GROQ_API_KEY` env var present and network access allowed.
- OpenRouter/Gemini errors: confirm `OPENROUTER_API_KEY` is valid and not rate-limited.

Optional improvements
- Persist `exportedClips` metadata to disk to restore UI after refresh.
- Toggle for face-centering in UI.
- Add a settings page to store API keys in a secure local config file.
- Add CI-friendly script to prebuild wheels or containerize the app (Docker).

If you want, I can also:
- Add a PowerShell helper script that sets env vars, activates venv and launches server + frontend.
- Create a Dockerfile that uses a simpler detection fallback (e.g., no mediapipe) for easier containerization.

License & Safety
- This repo is for local processing; be mindful of privacy and only process videos you own or have rights to.

---
Generated on April 11, 2026

- `ffmpeg` harus tersedia di `PATH`
- Node.js dan npm aktif

## Alur

1. Upload video
2. Preview video vertikal dan atur ukuran subtitle
3. Klik `Jadikan Clip Viral`
4. Frontend minta AI mendeteksi 5 segmen viral
5. Backend lokal memanggil `ffmpeg` sistem untuk membuat 5 file MP4 dengan subtitle burn-in
6. Hasil otomatis tersedia untuk diunduh
