<p align="center">
  <img src="public/openclipper.png" alt="Open Clipper Pro" width="140" />
</p>

<h1 align="center">Open Clipper Pro</h1>

<p align="center">
  Ubah video panjang jadi clip vertikal 9:16 untuk Reels, TikTok, dan Shorts.<br />
  Pemotongan, crop wajah, dan subtitle semuanya diproses di komputer kamu sendiri.
</p>

<p align="center">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=white" />
  <img alt="Vite 8" src="https://img.shields.io/badge/Vite-8-646cff?logo=vite&logoColor=white" />
  <img alt="FFmpeg" src="https://img.shields.io/badge/FFmpeg-local-007808?logo=ffmpeg&logoColor=white" />
  <img alt="AI" src="https://img.shields.io/badge/AI-OpenRouter%20%7C%20Ollama-6d28d9" />
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a>
</p>

---

## Fitur

- **Deteksi segmen viral dari isi video.**
  - Seluruh audio ditranskripsi dulu, lalu AI membaca transkrip bertimestamp untuk memilih momen terbaik.
  - Tiap segmen mendapat `viral_score` 1–100 dan alasan singkat.
  - Backend memvalidasi hasil AI: memotong di batas kata, menjaga durasi sesuai pilihan (15–30, 30–60, atau 60–90 detik), dan membuang segmen yang tumpang tindih.
- **Dua mode AI.** Pilih langsung di aplikasi:
  - **OpenRouter** (cloud, default model Gemini Flash Lite).
  - **Ollama** (lokal, tanpa API key, misalnya `gemma4:e4b`).
- **Potong 9:16 dengan FFmpeg** langsung di mesin kamu.
- **Crop mengikuti wajah** dengan MediaPipe (offline), jadi subjek tetap di tengah frame.
- **Subtitle otomatis.**
  - Audio ditranskripsi dengan Groq Whisper (`whisper-large-v3-turbo`, bahasa Indonesia).
  - Teksnya di-*burn* ke video sebagai subtitle ASS.
  - Ukuran dan posisi vertikalnya bisa diatur per clip.
- **Progres real-time** lewat Server-Sent Events.
- **API key aman.** Semua key hanya ada di backend (`.env`), tidak pernah dikirim ke browser.

## Cara kerja

```
Browser (React + Vite)                Backend lokal (Node, port 3030)
──────────────────────                ────────────────────────────────
Klik "Jadikan Clip Viral" ──────────▶ /api/process (upload video + pengaturan)
                                      ├─ Groq Whisper: transkrip seluruh video (per 10 menit)
                                      ├─ OpenRouter  atau  Ollama: pilih segmen dari transkrip
                                      ├─ validasi: batas kata, durasi, overlap
                                      ├─ FFmpeg: potong segmen + crop 9:16
                                      ├─ MediaPipe: cari posisi wajah
                                      └─ SSE: kirim progres ke browser
Generate Subtitle ──────────────────▶ word timing tersimpan ──▶ ASS ──▶ FFmpeg burn-in
Simpan Video ◀────────────────────── /outputs/*.mp4
```

> **Catatan:** tanpa `GROQ_API_KEY`, atau kalau video tidak berisi ucapan, AI hanya melihat durasi video sehingga pilihannya asal tebak. Aplikasi menampilkan peringatan saat hal ini terjadi.

## Prasyarat

| Kebutuhan | Versi | Cek |
|---|---|---|
| Node.js | 20+ (dikembangkan di 24) | `node --version` |
| Python | 3.10 / 3.11, 64-bit | `python --version` |
| FFmpeg | build lengkap (libass, libfreetype) | `ffmpeg -version` |
| Ollama *(opsional)* | terbaru | `ollama --version` |

## Instalasi

```bash
git clone git@github.com:ledjayrafael/open-clipper-pro.git
cd open-clipper-pro
npm install
```

Pasang dependensi Python untuk deteksi wajah (disarankan pakai virtualenv):

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .\.venv\Scripts\Activate.ps1
pip install -r server/requirements.txt
```

Kalau `mediapipe` gagal dipasang di Windows, pakai conda:

```bash
conda create -n openclipper python=3.10 -y
conda activate openclipper
conda install -c conda-forge mediapipe opencv -y
```

## Konfigurasi

Salin `.env.example` menjadi `.env` di root project, lalu isi:

| Variabel | Wajib | Fungsi |
|---|---|---|
| `OPENROUTER_API_KEY` | untuk mode OpenRouter | Analisis segmen lewat cloud |
| `GROQ_API_KEY` | sangat disarankan | Transkripsi Whisper. Dipakai AI untuk memilih segmen dan untuk subtitle. Tanpa key ini, AI hanya melihat durasi video. |
| `WHISPER_LANGUAGE` | opsional | Bahasa audio, default `id`. Kosongkan (`WHISPER_LANGUAGE=`) untuk deteksi otomatis. |
| `OPENROUTER_MODEL` | opsional | Default `google/gemini-3.1-flash-lite-preview` |
| `AI_PROVIDER` | opsional | Mode awal: `openrouter` atau `ollama` |
| `OLLAMA_URL` | opsional | Default `http://127.0.0.1:11434` |
| `OLLAMA_MODEL` | opsional | Model Ollama default |
| `CLIPPER_SERVER_PORT` | opsional | Port backend, default `3030` |

`.env` sudah di-*gitignore*. Jangan taruh key di `src/`, karena semua yang ada di sana ikut terkirim ke browser.

### Mode Ollama (tanpa API key)

```bash
ollama pull gemma4:e4b
ollama serve
```

Di aplikasi, pilih **Mode AI → Ollama**, lalu pilih modelnya. Model lokal lebih lambat dari cloud. Untuk model kecil, backend memaksa jawaban mengikuti JSON schema dan memperpanjang segmen yang terlalu pendek sampai durasi minimum. Transkripsi tetap memakai Groq, jadi mode Ollama tidak sepenuhnya offline.

## Menjalankan

Buka dua terminal di folder project:

```bash
npm run dev:server   # backend FFmpeg + AI, http://127.0.0.1:3030
```

```bash
npm run dev          # frontend, http://localhost:5173
```

Lalu buka <http://localhost:5173>.

## Alur pemakaian

1. **Pilih video.** Upload MP4, MOV, AVI, atau WebM.
2. **Preview.** Cek video sumber.
3. **Proses.** Pilih mode AI, jumlah clip, dan durasi per clip. Nyalakan atau matikan *Auto Face Detection*, lalu klik **Jadikan Clip Viral**.
4. **Atur subtitle per clip.** Sesuaikan ukuran dan posisi Y, lalu klik **Generate Subtitle**.
5. **Simpan Video.** Unduh clip yang sudah jadi.

## Struktur project

```
server/local-ffmpeg-server.mjs   backend: potong clip, subtitle, AI, SSE
server/face_detect.py            helper deteksi wajah MediaPipe
server/requirements.txt          dependensi Python
src/App.jsx                      UI React
public/openclipper.png          logo
vite.config.js                   proxy /api dan /outputs ke backend
```

## Troubleshooting

| Masalah | Solusi |
|---|---|
| "Server FFmpeg lokal belum aktif" | Jalankan `npm run dev:server`. |
| Crop wajah tidak jalan | Pastikan `python` di PATH adalah interpreter venv yang sudah memasang `server/requirements.txt`. |
| Error filter FFmpeg | Pakai build FFmpeg lengkap yang mendukung libass dan libfreetype. |
| Tombol Ollama nonaktif | Ollama belum jalan (`ollama serve`) atau belum ada model (`ollama pull …`). |
| OpenRouter error 401/429 | Key salah atau terkena rate limit. Cek `OPENROUTER_API_KEY` di `.env`. |
| Vite: *Cannot find native binding* | `node_modules` dipasang di OS lain. Hapus `node_modules` lalu jalankan `npm install` lagi. |

## Privasi

Video diproses di komputer kamu sendiri. Ada dua hal yang keluar dari komputer:

- Ke Groq: seluruh audio video untuk transkripsi, kalau `GROQ_API_KEY` diisi. Ini juga berlaku di mode Ollama.
- Ke OpenRouter: transkrip dan durasi video. Ini tidak terjadi di mode Ollama.

Proses hanya video yang kamu miliki atau punya hak untuk mengeditnya.

## Lisensi

Dirilis di bawah [MIT License](LICENSE).
