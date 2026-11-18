# Catatan improvement: Open Clipper Pro vs yt-short-clipper

Pembanding: [jipraks/yt-short-clipper](https://github.com/jipraks/yt-short-clipper) v2, dibaca pada 2026-11-18. Proyek itu memakai MIT License, jadi idenya boleh diadopsi, asalkan kode yang disalin tetap mencantumkan atribusi.

## Ringkasan perbedaan

| Aspek | Open Clipper Pro (sekarang) | yt-short-clipper |
|---|---|---|
| Platform | Web lokal (React + Node), lintas OS | Desktop Tauri + sidecar Python, hanya Windows |
| Input | Upload file video | URL YouTube (yt-dlp + cookies) |
| Dasar pemilihan segmen | **Hanya nama file + durasi** | **Transkrip lengkap** dengan timestamp |
| Durasi clip | Bebas, ditentukan AI | Divalidasi 58–120 detik, dengan request clip lebih banyak lalu difilter |
| Pilih clip sebelum render | Tidak, semua langsung dirender | Ya, ada halaman *Highlight Selection* |
| Reframe | Crop statis dari 1 frame, wajah terbesar | Tracking per frame (EMA, deadzone, snap saat ganti scene, bonus untuk pembicara aktif), plus mode *centered black* dan *centered blur* |
| Caption | 2 kata per baris, statis | 4 kata per baris, kata aktif disorot kuning ala CapCut, huruf kapital |
| Hook text | Tidak ada | Overlay judul di 5 detik pertama, gaya bisa diatur |
| Watermark | Tidak ada | Logo dan teks kredit |
| Encoder | `libx264 veryfast` | Deteksi GPU (NVENC, AMF, QSV, VideoToolbox) dengan probe, fallback ke CPU |
| Padding | Tidak ada | Lead-in 1,5 detik, tail-out 2,5 detik |
| Arahan user | Tidak ada | *AI direction*: teks bebas, termasuk rentang waktu persis seperti `2:00 - 2:50` |
| Bahasa output | Prompt bahasa Indonesia tetap | Pilihan bahasa output, default mengikuti bahasa video |
| Provider AI | OpenRouter / Ollama | Endpoint apa pun yang kompatibel OpenAI, dengan preset |
| Riwayat | Tidak ada, hilang saat refresh | Session dan Library tersimpan |
| Parsing JSON | Ambil `{…}` terluar | Salvage per objek, jadi satu objek rusak tidak menggagalkan semuanya |

Yang **sudah lebih baik** di Open Clipper Pro dan perlu dipertahankan:
- Lintas OS, tanpa Rust atau build sidecar.
- Bisa memakai video lokal apa pun, bukan hanya YouTube, dan tanpa cookies akun Google.
- Ollama mendapat structured output lewat JSON schema.
- Transkripsi Whisper berjalan untuk video yang tidak punya subtitle.
- Tanpa telemetri dan tanpa backend pihak ketiga.

## Prioritas improvement

### P0: dampak terbesar (selesai)

> Sudah dikerjakan: transkrip penuh lewat Groq per 10 menit, prompt berbasis transkrip, over-request N+3, validasi durasi dan overlap, snap ke batas kata, word timing disimpan untuk subtitle, dan parser JSON yang bisa menyelamatkan objek yang masih utuh. Transkripsi lokal untuk mode Ollama (`whisper.cpp` atau `faster-whisper`) belum dikerjakan.

1. **Analisis berbasis transkrip.** Ini kelemahan paling besar: saat ini AI menebak segmen hanya dari nama file.
   - Transkripsi video penuh di awal. Pakai Groq Whisper dan potong audio per sekitar 10 menit karena ada batas ukuran file. Fallback-nya `whisper.cpp` atau `faster-whisper` lokal untuk mode Ollama.
   - Kirim transkrip bertimestamp (`[mm:ss] teks`) ke prompt.
   - Simpan *word timing* penuh di server, supaya tahap subtitle cukup memotong data yang sudah ada dan tidak perlu mentranskripsi ulang per clip. Ini juga menghemat kuota Groq.
   - Untuk video yang panjang, Ollama butuh `num_ctx` yang cukup besar, atau transkrip diringkas dulu per chunk.
2. **Validasi durasi dan over-request.**
   - Minta N+3 segmen, buang yang di luar rentang target (misalnya 30–90 detik, bisa diatur di UI), buang yang saling tumpang tindih, lalu ambil N teratas.
   - Validasi ini perlu dilakukan di backend, tidak cukup hanya di prompt.
3. **Prompt yang lebih tajam.** Contoh kriteria dari referensi:
   - Pilih momen dengan konflik, pengakuan, opini berani, punchline, atau cerita yang lengkap.
   - Hindari basa-basi dan transisi topik.
   - Sebar pilihan ke seluruh durasi video.
   - Jangan mengarang timestamp.

### P1: kualitas output (selesai)

> Sudah dikerjakan: face tracking per frame lewat `server/face_track.py` (MediaPipe Tasks, EMA dan deadzone, deteksi pergantian kamera, tetap pada subjek dalam satu shot, dan crop dikirim ke FFmpeg lewat `sendcmd`), mode reframe crop tengah, utuh + blur, dan utuh + hitam, caption karaoke, serta padding ke jeda hening. Bonus pembicara aktif (gerak bibir) belum dikerjakan.

4. **Face tracking per frame.**
   - Ganti crop statis dengan posisi per frame: sampling, misalnya, 5 fps, lalu haluskan dengan EMA (sekitar 0,15). Tambahkan deadzone 2% supaya tidak bergetar, dan snap langsung kalau lompatannya lebih dari 35% (ganti scene).
   - Cara yang lebih ringan daripada encode frame mentah lewat pipe: ubah posisi menjadi ekspresi `crop` ber-keyframe, atau buat beberapa crop per segmen scene yang digabung dengan `sendcmd`.
   - Opsional: bonus untuk pembicara aktif, diukur dari bukaan bibir dengan Face Landmarker, supaya podcast dua orang mengikuti siapa yang sedang bicara.
5. **Mode reframe alternatif.** *Centered + blur background* hanya butuh satu pass FFmpeg (`split`, `scale`, `boxblur`, `overlay`). Hasilnya cepat dan cocok untuk konten yang tidak berpusat pada wajah.
6. **Caption karaoke.** Sorot kata yang sedang diucapkan (`\c&H00FFFF&` atau tag `\k`), pakai huruf kapital, font tebal, dan outline. Hitung `PlayRes` dari resolusi asli video. Sediakan pilihan preset gaya.
7. **Padding** lead-in dan tail-out, supaya kalimat tidak terpotong di awal atau akhir clip. Tambahkan juga snap ke batas kata dari word timing.

### P2: alur kerja dan UX (8–11 selesai)

> Sudah dikerjakan: halaman pilih dan edit highlight dengan preview, AI direction (rentang waktu diambil persis, temperature lebih rendah, analisis ulang tanpa transkripsi), hook text overlay, serta session dan Riwayat. Input URL YouTube (12) belum dikerjakan.

8. **Halaman pilih highlight sebelum render.** Tampilkan daftar segmen dengan skor, judul, alasan, dan durasi. User mencentang yang mau dirender dan bisa mengedit start/end. Ini menghemat waktu render.
9. **AI direction.**
   - Kolom teks bebas, misalnya "fokus bagian soal bisnis", "skip intro", atau "2:00 - 2:50".
   - Rentang waktu yang ditulis eksplisit dihormati persis.
   - Saat ada arahan, pakai temperature rendah (0,3).
   - Sanitasi teksnya supaya tidak bisa menyuntikkan placeholder prompt.
10. **Hook text overlay** di 3–5 detik pertama, dengan teks `hook_text` dari AI. Pakai `drawtext` atau ASS, dengan warna dan posisi yang bisa diatur.
11. **Session dan Library.**
    - Simpan hasil analisis dan clip per video, misalnya di `outputs/<session>/session.json`.
    - Library menampilkan riwayat, supaya refresh halaman tidak menghilangkan hasil.
12. **Input URL YouTube (opsional).** Gunakan yt-dlp dan unduh hanya section yang dipilih (`--download-sections`). Wajib ada disclaimer hak cipta, seperti di referensi.

### P3: performa dan ketahanan (selesai)

> Sudah dikerjakan: encoder GPU dengan probe dan fallback ke CPU per clip (opsional lewat `VIDEO_ENCODER`), parser JSON salvage (sejak P0), retry dengan backoff dan pesan error yang bisa ditindaklanjuti untuk OpenRouter, provider custom, dan Groq, watchdog FFmpeg dan timeout proses, serta provider generik yang kompatibel OpenAI.
>
> Catatan pengukuran (RTX 3060, CPU desktop, sumber 1080p60): NVENC 30–40% **lebih lambat** dari libx264 veryfast, dan filenya 1,3–2,5x lebih besar, karena decode dan filter tetap jalan di CPU. Karena itu default-nya CPU, dan GPU hanya opsi untuk mesin dengan CPU lemah.

13. **Hardware encoder.** Deteksi `h264_nvenc`, `h264_qsv`, `h264_amf`, atau `h264_vaapi` (Linux) dengan percobaan encode 1 frame, lalu fallback ke `libx264`.
14. **Parser JSON yang lebih toleran.** Hilangkan pagar ```` ``` ````, coba `JSON.parse`, dan kalau gagal, salvage per objek `{…}` (lihat `parse_highlights_json`).
15. **Pesan error AI yang bisa ditindaklanjuti**, misalnya untuk 500/timeout ("coba lagi, ganti model, atau video terlalu panjang") dan untuk respons kosong. Tambahkan retry dengan backoff, misalnya `max_retries=4`.
16. **Watchdog encode.** Kill FFmpeg kalau progres tidak bergerak selama lebih dari N detik, supaya job tidak menggantung selamanya.
17. **Provider generik yang kompatibel OpenAI**, yaitu `base_url` + `api_key` + `model`. Dengan itu Groq, Gemini, OpenAI, vLLM, dan LM Studio otomatis didukung tanpa kode baru.

### Tidak perlu ditiru

- Wallet in-app, top-up, dan backend milik maintainer: tidak cocok dengan konsep "semua lokal".
- Google Analytics dan menu sidebar dari server: bertentangan dengan janji privasi di README.
- Integrasi Repliz: terlalu spesifik untuk satu platform.
- Shell Tauri dan build yang hanya untuk Windows: sekarang aplikasi web lokal sudah lintas OS.

## Urutan kerja yang disarankan

1. Transkrip penuh, prompt berbasis transkrip, dan validasi durasi (P0). Hasilnya paling terasa.
2. Halaman pilih highlight dan padding.
3. Caption karaoke dan reframe *blur*.
4. Face tracking per frame.
5. Session/Library, hook, dan hardware encoder.
