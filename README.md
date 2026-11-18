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
- **Pilih dan edit sebelum render.** Daftar highlight dari AI bisa dicentang, diedit judul, hook, dan waktu mulai/selesainya, dan dipreview langsung di video sumber.
- **Arahan untuk AI.** Tulis misalnya "fokus ke bagian soal bisnis" atau "ambil 2:00 - 2:50". Rentang waktu yang ditulis diambil persis. Hasil yang kurang cocok bisa dianalisis ulang tanpa upload atau transkripsi lagi.
- **Hook text.** Kalimat pembuka dari AI (bisa diedit) tampil di 4 detik pertama clip.
- **Riwayat.** Setiap video tersimpan sebagai session. Buka lagi kapan saja untuk render ulang atau menambah clip, atau hapus beserta semua clip-nya.
- **Dua mode AI.** Pilih langsung di aplikasi:
  - **OpenRouter** (cloud, default model Gemini Flash Lite).
  - **Ollama** (lokal, tanpa API key, misalnya `gemma4:e4b`).
- **Potong 9:16 dengan FFmpeg** langsung di mesin kamu.
- **Reframe 9:16** dengan empat pilihan:
  - **Ikuti wajah:** crop bergerak halus mengikuti wajah utama (MediaPipe), langsung pindah saat kamera berganti, dan tidak bolak-balik antar orang dalam satu shot.
  - **Crop tengah**, **Utuh + blur** (seluruh frame dengan latar blur), dan **Utuh + hitam**.
- **Potongan rapi.** Awal dan akhir clip digeser ke batas kata lalu diberi jeda sampai keheningan terdekat, jadi kalimat tidak terpotong.
- **Subtitle otomatis.**
  - Audio ditranskripsi dengan Groq Whisper (`whisper-large-v3-turbo`, bahasa Indonesia).
  - Teksnya di-*burn* ke video sebagai subtitle ASS, dengan gaya karaoke: kata yang sedang diucapkan disorot kuning (bisa dimatikan).
  - Ukuran dan posisi vertikalnya bisa diatur per clip.
- **Progres real-time** lewat Server-Sent Events.
- **API key aman.** Semua key hanya ada di backend (`.env`), tidak pernah dikirim ke browser.

## Cara kerja

```
Browser (React + Vite)                Backend lokal (Node, port 3030)
──────────────────────                ────────────────────────────────
Klik "Cari Highlight Viral" ────────▶ POST /api/sessions (upload video + pengaturan + arahan)
                                      ├─ Groq Whisper: transkrip seluruh video (per 10 menit)
                                      ├─ OpenRouter  atau  Ollama: usulkan highlight dari transkrip
                                      └─ validasi: batas kata, durasi, overlap, rentang yang diminta
Pilih + edit highlight ─────────────▶ POST /api/sessions/:id/render
                                      ├─ FFmpeg: potong segmen + crop 9:16 + hook text
                                      └─ face_track.py: jalur crop per frame (MediaPipe)
Generate Subtitle ──────────────────▶ word timing tersimpan ──▶ ASS ──▶ FFmpeg burn-in
(semua progres dikirim lewat SSE)
Simpan Video ◀────────────────────── /outputs/*.mp4
```

> **Catatan:** tanpa `GROQ_API_KEY`, atau kalau video tidak berisi ucapan, AI hanya melihat durasi video sehingga pilihannya asal tebak. Aplikasi menampilkan peringatan saat hal ini terjadi.

## Prasyarat

| Kebutuhan | Versi | Cek |
|---|---|---|
| Node.js | 20+ (dikembangkan di 24) | `node --version` |
| Python | 3.10–3.13, 64-bit | `python --version` |
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

Saat face tracking pertama kali dipakai, model deteksi wajah `blaze_face_short_range.tflite` (sekitar 230 KB) diunduh dari storage resmi MediaPipe ke `server/models/`. Kalau unduhan gagal atau MediaPipe tidak ada, tracking memakai Haar cascade bawaan OpenCV (kurang akurat). Kalau OpenCV juga tidak ada, clip memakai crop tengah.

Kalau server tidak memakai Python dari venv ini, set `PYTHON_BIN` di `.env` (lihat Konfigurasi).

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
| `PYTHON_BIN` | opsional | Interpreter Python untuk face tracking, default `python`. Arahkan ke venv, misalnya `.venv/bin/python` atau `.venv\Scripts\python.exe`. |

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
3. **Cari highlight.** Pilih mode AI, jumlah clip, durasi per clip, dan (opsional) tulis arahan untuk AI. Klik **Cari Highlight Viral**.
4. **Pilih highlight.** Centang yang mau dirender, edit judul, hook, atau waktunya, dan klik **Preview** untuk mengecek. Kalau kurang cocok, pakai **Analisis ulang** dengan arahan lain. Lalu klik **Render**.
5. **Atur subtitle per clip.** Sesuaikan ukuran dan posisi Y, lalu klik **Generate Subtitle**.
6. **Simpan Video.** Unduh clip yang sudah jadi. Semua session bisa dibuka lagi dari **Riwayat**.

## Struktur project

```
server/local-ffmpeg-server.mjs   backend: potong clip, subtitle, AI, SSE
server/face_track.py             face tracking: jalur crop 9:16 per frame
server/requirements.txt          dependensi Python
src/App.jsx                      UI React (alur utama)
src/components/HighlightReview.jsx  daftar highlight yang bisa diedit
src/components/Library.jsx       riwayat session
public/openclipper.png          logo
vite.config.js                   proxy /api dan /outputs ke backend
```

## Troubleshooting

| Masalah | Solusi |
|---|---|
| "Server FFmpeg lokal belum aktif" | Jalankan `npm run dev:server`. |
| Kartu clip menulis "face tracking gagal, crop tengah" | Python yang dipakai server belum punya OpenCV/MediaPipe. Pasang `server/requirements.txt`, atau set `PYTHON_BIN` di `.env` ke interpreter venv-nya. |
| "tidak ada wajah, crop tengah" | Tidak ada wajah terdeteksi (misalnya subjek membelakangi kamera atau terlalu jauh). Coba mode **Utuh + blur**. |
| Error filter FFmpeg | Pakai build FFmpeg lengkap yang mendukung libass dan libfreetype. |
| Tombol Ollama nonaktif | Ollama belum jalan (`ollama serve`) atau belum ada model (`ollama pull …`). |
| OpenRouter error 401/429 | Key salah atau terkena rate limit. Cek `OPENROUTER_API_KEY` di `.env`. |
| Vite: *Cannot find native binding* | `node_modules` dipasang di OS lain. Hapus `node_modules` lalu jalankan `npm install` lagi. |

## Penyimpanan

Hasil clip ada di `local-exports/`. Setiap session menyimpan salinan video sumber dan transkripnya di `local-exports/.sessions/<id>/`, supaya bisa dibuka dan dirender ulang tanpa upload lagi. Hapus session dari **Riwayat** untuk mengosongkan ruang disk. Clip, subtitle, dan salinan videonya ikut terhapus.

## Privasi

Video diproses di komputer kamu sendiri. Ada dua hal yang keluar dari komputer:

- Ke Groq: seluruh audio video untuk transkripsi, kalau `GROQ_API_KEY` diisi. Ini juga berlaku di mode Ollama.
- Ke OpenRouter: transkrip dan durasi video. Ini tidak terjadi di mode Ollama.

Proses hanya video yang kamu miliki atau punya hak untuk mengeditnya.

## Lisensi

Dirilis di bawah [MIT License](LICENSE).
