import React, { useState, useEffect, useRef } from 'react';
import {
  UploadCloud, FileVideo, Sparkles, Download, Play, Pause,
  CheckCircle2, Loader2, Cpu, ShieldCheck, Trash2,
  Volume2, VolumeX, Type, MoveVertical, Save, TrendingUp
} from 'lucide-react';

const OPENROUTER_API_KEY = "REMOVED_OPENROUTER_KEY";

export default function App() {
  const [videoFile, setVideoFile] = useState(null);
  const [videoSrc, setVideoSrc] = useState(null);
  const [subtitleSize, setSubtitleSize] = useState(22);
  const [subtitleY, setSubtitleY] = useState(0);
  const [status, setStatus] = useState('idle');
  const [ffmpegLoaded, setFfmpegLoaded] = useState(false);
  const [progress, setProgress] = useState({ step: '', detail: '', percent: 0 });
  const [exportedClips, setExportedClips] = useState([]);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [engineMode, setEngineMode] = useState('checking');

  const videoRef = useRef(null);

  // 1. Detect backend local FFmpeg server
  useEffect(() => {
    const checkBackend = async () => {
      try {
        setStatus('loading-lib');
        setProgress({ step: 'Mengecek engine lokal...', detail: 'Menghubungi server FFmpeg sistem', percent: 20 });
        const response = await fetch('/api/health');
        if (!response.ok) {
          throw new Error('Server lokal belum aktif');
        }
        const payload = await response.json();
        setEngineMode(payload.mode || 'system-ffmpeg');
        setFfmpegLoaded(true);
        setStatus('idle');
      } catch (err) {
        console.error('Backend FFmpeg Error:', err);
        setEngineMode('offline');
        setProgress({
          step: 'Server FFmpeg lokal belum aktif',
          detail: 'Jalankan npm run dev:server untuk memproses clip.',
          percent: 0,
        });
        setStatus('idle');
      }
    };
    checkBackend();
  }, []);

  // 2. Video sync
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const sync = () => setCurrentTime(v.currentTime);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onMeta = () => setVideoDuration(v.duration || 0);

    v.addEventListener('timeupdate', sync);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('loadedmetadata', onMeta);
    if (v.readyState >= 1) setVideoDuration(v.duration || 0);

    return () => {
      v.removeEventListener('timeupdate', sync);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('loadedmetadata', onMeta);
    };
  }, [videoSrc]);

  const togglePlay = (e) => {
    e?.stopPropagation();
    if (!videoRef.current) return;
    videoRef.current.paused ? videoRef.current.play() : videoRef.current.pause();
  };

  const handleSeek = (e) => {
    if (!videoRef.current || !videoDuration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    videoRef.current.currentTime = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * videoDuration;
  };

  const fmt = (s) => {
    const mm = Math.floor((s || 0) / 60).toString().padStart(2, '0');
    const ss = Math.floor((s || 0) % 60).toString().padStart(2, '0');
    return `${mm}:${ss}`;
  };

  const escapeFFmpegText = (text) =>
    text.replace(/[\\'"]/g, '').replace(/:/g, ' ').replace(/;/g, ' ').replace(/[\[\]]/g, '');

  // 3. MAIN: Detect viral segments + export 5 clips with subtitles
  const processViralClips = async () => {
    if (!videoFile) {
      alert('Harap pilih video terlebih dahulu.');
      return;
    }
    if (!ffmpegLoaded) {
      alert('Server FFmpeg lokal belum aktif. Jalankan npm run dev:server terlebih dahulu.');
      return;
    }

    setStatus('processing');
    setExportedClips([]);

    try {
      // Step A: AI Analysis
      setProgress({ step: 'Analisis AI', detail: 'Mendeteksi segmen viral (3-10 clip)...', percent: 5 });
      const duration = videoDuration || 60;

      const prompt = `Anda adalah ahli editor video viral profesional.
Video berdurasi ${Math.round(duration)} detik. Temukan 3 sampai 10 segmen terbaik untuk clip viral vertikal (Reels/TikTok/Shorts).
ATURAN:
- Minimal 3 segmen, Maksimal 10 segmen. Jumlah tergantung panjang video dan kualitas konten.
- start dan end dalam detik (angka bulat), rentang 0-${Math.round(duration)}
- Durasi tiap segmen 15-60 detik, TIDAK overlap
- Setiap segmen WAJIB punya "viral_score" (1-100) yang menunjukkan seberapa viral segmen tersebut
- Setiap segmen WAJIB punya array 'captions' (4-6 caption per segmen, maks 8 kata per caption)
- Caption: text, start_offset, end_offset (relatif dari start segmen, detik)
- Caption harus menutupi seluruh durasi segmen tanpa gap
- Urutkan dari viral_score tertinggi ke terendah
Format JSON MURNI:
{"moments":[{"id":1,"start":0,"end":20,"title":"Hook Awal","viral_score":85,"captions":[{"text":"INI DIA RAHASIANYA","start_offset":0,"end_offset":4},{"text":"WAJIB NONTON SAMPAI HABIS","start_offset":4,"end_offset":8}]}]}`;

      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        },
        body: JSON.stringify({
          model: "google/gemini-3.1-flash-lite-preview",
          messages: [
            { role: "system", content: prompt },
            { role: "user", content: `Analisis video "${videoFile.name}" (durasi: ${Math.round(duration)}s). Temukan 3-10 segmen paling viral dengan skor viralnya.` }
          ],
          response_format: { type: "json_object" }
        })
      });

      if (!response.ok) throw new Error(`API Error: ${response.status}`);
      const result = await response.json();
      const content = JSON.parse(result.choices[0].message.content);

      // Normalize moments & distribute captions evenly
      let moments = content.moments.map((m, idx) => {
        const start = Math.max(0, Math.min(parseFloat(m.start), duration));
        const end = Math.max(start + 5, Math.min(parseFloat(m.end), duration));
        const dur = end - start;
        const viralScore = Math.max(1, Math.min(100, Math.round(Number(m.viral_score) || 50)));
        const rawCaptions = m.captions || [];
        const captions = rawCaptions.length > 0
          ? rawCaptions.map((c, i) => {
              const segLen = dur / rawCaptions.length;
              return {
                text: c.text || 'VIRAL MOMENT',
                start_offset: parseFloat((i * segLen).toFixed(2)),
                end_offset: parseFloat(((i + 1) * segLen - 0.05).toFixed(2))
              };
            })
          : [{ text: m.title || 'VIRAL', start_offset: 0, end_offset: dur }];
        return { id: idx + 1, start, end, duration: dur, captions, title: m.title || `Clip ${idx + 1}`, viralScore };
      });
      // Enforce 3-10 clip range
      moments = moments.slice(0, 10);
      if (moments.length < 3) {
        throw new Error(`AI hanya menemukan ${moments.length} segmen. Minimal 3 diperlukan. Coba video yang lebih panjang.`);
      }

      setProgress({ step: 'Analisis AI', detail: `${moments.length} segmen ditemukan!`, percent: 15 });

      // Step B: Send job to local backend (plain clips, no subtitles)
      setProgress({ step: 'Ekspor lokal', detail: 'Memotong clip tanpa subtitle...', percent: 20 });
      const formData = new FormData();
      formData.append('video', videoFile);
      formData.append('moments', JSON.stringify(moments));

      const processResponse = await fetch('/api/process', {
        method: 'POST',
        body: formData,
      });

      const processPayload = await processResponse.json();
      if (!processResponse.ok || !processPayload.ok) {
        throw new Error(processPayload.error || 'Backend processing gagal.');
      }

      const { jobId } = processPayload;

      // Real-time progress via SSE
      const clips = await new Promise((resolve, reject) => {
        const evtSource = new EventSource(`/api/progress/${jobId}`);

        evtSource.addEventListener('progress', (e) => {
          const data = JSON.parse(e.data);
          setProgress({ step: data.step, detail: data.detail, percent: data.percent });
        });

        evtSource.addEventListener('done', (e) => {
          evtSource.close();
          const result = JSON.parse(e.data);
          if (result.ok) resolve(result.clips);
          else reject(new Error(result.error || 'Processing gagal.'));
        });

        evtSource.onerror = () => {
          evtSource.close();
          reject(new Error('Koneksi ke server terputus.'));
        };
      });

      setProgress({ step: 'Pemotongan selesai', detail: `${clips.length} clip siap di-preview`, percent: 100 });
      setExportedClips(clips.map((c, i) => ({
        ...c,
        viralScore: moments[i]?.viralScore ?? null,
        subtitleStatus: 'idle', subtitledUrl: null, subtitledFilename: null, subProgress: 0,
        clipSubSize: subtitleSize, clipSubY: subtitleY,
      })));
      setStatus('completed');

    } catch (err) {
      console.error('Process Error:', err);
      setStatus('idle');
      alert('Gagal memproses: ' + err.message);
    }
  };

  // Generate subtitle for a single clip
  const generateSubtitle = async (clipIndex) => {
    const clip = exportedClips[clipIndex];
    if (!clip || clip.subtitleStatus === 'processing') return;

    setExportedClips(prev => prev.map((c, i) => i === clipIndex ? { ...c, subtitleStatus: 'processing', subProgress: 0 } : c));

    try {
      const resp = await fetch('/api/add-subtitle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clipFilename: clip.filename,
          captions: clip.captions,
          subtitleSize: clip.clipSubSize ?? subtitleSize,
          subtitleY: clip.clipSubY ?? subtitleY,
          clipDuration: clip.duration,
        }),
      });
      const payload = await resp.json();
      if (!resp.ok || !payload.ok) throw new Error(payload.error || 'Gagal');

      const { jobId } = payload;

      await new Promise((resolve, reject) => {
        const evtSource = new EventSource(`/api/progress/${jobId}`);
        evtSource.addEventListener('progress', (e) => {
          const data = JSON.parse(e.data);
          setExportedClips(prev => prev.map((c, i) => i === clipIndex ? { ...c, subProgress: data.percent } : c));
        });
        evtSource.addEventListener('done', (e) => {
          evtSource.close();
          const result = JSON.parse(e.data);
          if (result.ok) {
            setExportedClips(prev => prev.map((c, i) => i === clipIndex ? {
              ...c, subtitleStatus: 'done', subProgress: 100,
              subtitledUrl: result.url, subtitledFilename: result.filename,
            } : c));
            resolve();
          } else {
            reject(new Error(result.error));
          }
        });
        evtSource.onerror = () => { evtSource.close(); reject(new Error('Koneksi terputus')); };
      });
    } catch (err) {
      console.error('Subtitle Error:', err);
      setExportedClips(prev => prev.map((c, i) => i === clipIndex ? { ...c, subtitleStatus: 'idle', subProgress: 0, subtitledUrl: null, subtitledFilename: null } : c));
      alert(`Gagal generate subtitle clip ${clip.id}: ${err.message}`);
    }
  };

  return (
    <div className="min-h-screen bg-[#050505] text-slate-100 font-sans selection:bg-indigo-500/30">
      {/* Status Bar */}
      <div className="w-full bg-indigo-600/10 border-b border-indigo-500/10 px-6 py-2 flex justify-between items-center text-[10px] font-black tracking-widest text-indigo-400 uppercase">
        <div className="flex items-center gap-2">
          <ShieldCheck size={14} /> LOCAL PROCESSING
        </div>
        <span className="flex items-center gap-1.5">
          <Cpu size={12} className={ffmpegLoaded ? "text-green-400 animate-pulse" : "text-slate-500"} />
          ENGINE: {ffmpegLoaded ? engineMode.toUpperCase() : "OFFLINE"}
        </span>
      </div>

      <div className="max-w-5xl mx-auto p-6 md:p-12">
        {/* Header */}
        <header className="mb-10 text-center">
          <h1 className="text-5xl md:text-6xl font-black italic tracking-tighter bg-gradient-to-r from-white via-indigo-200 to-slate-600 bg-clip-text text-transparent uppercase">
            Clipper.Pro
          </h1>
          <p className="text-slate-500 font-bold mt-2 uppercase tracking-[0.2em] text-[10px]">AI Viral Clip Generator // Local Processing</p>
        </header>

        {status === 'loading-lib' ? (
          <div className="py-32 text-center">
            <Loader2 className="w-14 h-14 animate-spin text-indigo-500 mx-auto mb-6" />
            <p className="text-slate-400 font-mono text-xs uppercase tracking-widest">{progress.step}</p>
            <div className="mt-4 w-64 mx-auto h-1.5 bg-slate-800 rounded-full overflow-hidden">
              <div className="h-full bg-indigo-500 transition-all duration-500" style={{ width: `${progress.percent}%` }} />
            </div>
          </div>
        ) : (
          <div className="space-y-8">

            {engineMode === 'offline' && (
              <div className="bg-amber-500/10 border border-amber-500/20 rounded-2xl p-5 text-left">
                <p className="text-[10px] font-black uppercase tracking-widest text-amber-300">Server FFmpeg lokal belum aktif</p>
                <p className="text-xs text-slate-400 mt-2">Jalankan <span className="font-mono text-amber-200">npm run dev:server</span> di terminal terpisah, lalu refresh halaman.</p>
              </div>
            )}

            {/* STEP 1: Upload Video */}
            <div className="bg-[#0A0A0A] border border-slate-800/60 rounded-3xl p-8">
              <div className="flex items-center gap-3 mb-6">
                <span className="bg-indigo-600 text-white text-[10px] font-black w-6 h-6 flex items-center justify-center rounded-full">1</span>
                <h2 className="text-sm font-black uppercase tracking-widest">Pilih Video</h2>
              </div>

              {!videoFile ? (
                <div className="border-2 border-dashed border-slate-800 rounded-2xl p-10 text-center relative group hover:border-indigo-500/50 transition-all cursor-pointer">
                  <input type="file" accept="video/*" className="absolute inset-0 opacity-0 cursor-pointer z-10" onChange={(e) => {
                    const file = e.target.files[0];
                    if (file) {
                      if (videoSrc) URL.revokeObjectURL(videoSrc);
                      setVideoFile(file);
                      setVideoSrc(URL.createObjectURL(file));
                      setExportedClips([]);
                      setStatus('idle');
                    }
                  }} />
                  <UploadCloud className="mx-auto mb-3 text-slate-700 group-hover:text-indigo-400 transition-colors" size={48} />
                  <p className="text-sm font-bold text-slate-400 uppercase tracking-wider">Klik atau drag video ke sini</p>
                  <p className="text-[10px] text-slate-600 mt-1">MP4, MOV, AVI, WebM</p>
                </div>
              ) : (
                <div className="flex items-center justify-between p-4 bg-black/60 border border-slate-800 rounded-xl">
                  <div className="flex items-center gap-3 overflow-hidden">
                    <FileVideo className="text-indigo-400 shrink-0" size={22} />
                    <div className="overflow-hidden">
                      <p className="text-xs font-bold truncate text-slate-200">{videoFile.name}</p>
                      <p className="text-[9px] text-slate-600 mt-0.5">{(videoFile.size / (1024 * 1024)).toFixed(1)} MB {videoDuration > 0 && `• ${fmt(videoDuration)}`}</p>
                    </div>
                  </div>
                  <button onClick={() => {
                    if (videoSrc) URL.revokeObjectURL(videoSrc);
                    setVideoFile(null); setVideoSrc(null); setExportedClips([]); setStatus('idle');
                  }} className="text-slate-600 hover:text-red-500 p-2"><Trash2 size={18} /></button>
                </div>
              )}
            </div>

            {/* STEP 2: Preview + Subtitle Size */}
            {videoSrc && (
              <div className="bg-[#0A0A0A] border border-slate-800/60 rounded-3xl p-8">
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-3">
                    <span className="bg-indigo-600 text-white text-[10px] font-black w-6 h-6 flex items-center justify-center rounded-full">2</span>
                    <h2 className="text-sm font-black uppercase tracking-widest">Preview & Atur Subtitle</h2>
                  </div>
                  <button onClick={() => setIsMuted(!isMuted)} className="p-2 bg-slate-900 border border-slate-800 rounded-lg hover:text-indigo-400 transition-colors">
                    {isMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
                  </button>
                </div>

                {/* 9:16 Video Preview */}
                <div className="flex justify-center">
                  <div className="relative w-full max-w-[300px] aspect-[9/16] bg-black rounded-2xl overflow-hidden border border-slate-800 shadow-2xl group cursor-pointer" onClick={togglePlay}>
                    <video src={videoSrc} className="absolute inset-0 h-full w-full object-cover opacity-15 blur-2xl scale-125" muted loop autoPlay />
                    <video ref={videoRef} src={videoSrc} muted={isMuted} className="absolute inset-0 h-full w-full object-cover" />

                    {/* Sample subtitle preview */}
                    <div className="absolute z-20 pointer-events-none" style={{ left: '50%', transform: 'translateX(-50%)', bottom: `calc(10px + ${subtitleY}%)` }}>
                      <span
                        className="text-white font-black px-3 py-1.5 bg-black/60 rounded-lg inline-block leading-tight whitespace-nowrap"
                        style={{ fontSize: `${subtitleSize}px`, textShadow: '0 2px 4px rgba(0,0,0,1)' }}
                      >
                        PREVIEW SUBTITLE
                      </span>
                    </div>

                    {/* Play/Pause overlay */}
                    <div className={`absolute inset-0 z-10 flex items-center justify-center transition-opacity duration-300 ${isPlaying ? 'opacity-0 group-hover:opacity-100' : 'opacity-100 bg-black/30'}`}>
                      <div className="bg-white/15 backdrop-blur-xl p-5 rounded-full border border-white/20 hover:scale-110 transition-transform">
                        {isPlaying ? <Pause className="text-white fill-white" size={32} /> : <Play className="text-white fill-white ml-1" size={32} />}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Timeline Progress Bar */}
                <div className="mt-5 max-w-[400px] mx-auto space-y-1">
                  <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden cursor-pointer group" onClick={handleSeek}>
                    <div className="h-full bg-indigo-500 rounded-full relative" style={{ width: `${videoDuration ? (currentTime / videoDuration) * 100 : 0}%`, transition: 'width 0.15s linear' }}>
                      <div className="absolute right-0 top-1/2 -translate-y-1/2 w-2.5 h-2.5 bg-white rounded-full shadow -mr-1 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>
                  </div>
                  <div className="flex justify-between text-[9px] font-mono text-slate-600">
                    <span>{fmt(currentTime)}</span>
                    <span>{fmt(videoDuration)}</span>
                  </div>
                </div>

                {/* Subtitle Size Slider */}
                <div className="mt-5 max-w-[400px] mx-auto flex items-center gap-4">
                  <Type size={14} className="text-slate-500 shrink-0" />
                  <span className="text-[9px] font-black uppercase tracking-widest text-slate-500 shrink-0">Ukuran Subtitle</span>
                  <input type="range" min={12} max={36} value={subtitleSize} onChange={e => setSubtitleSize(Number(e.target.value))} className="flex-1 accent-indigo-500 cursor-pointer" />
                  <span className="text-[10px] font-bold text-indigo-400 w-5 text-right">{subtitleSize}</span>
                </div>
                {/* Subtitle Y Position Slider */}
                <div className="mt-3 max-w-[400px] mx-auto flex items-center gap-4">
                  <MoveVertical size={14} className="text-slate-500 shrink-0" />
                  <span className="text-[9px] font-black uppercase tracking-widest text-slate-500 shrink-0">Posisi Vertikal</span>
                  <input type="range" min={0} max={100} value={subtitleY} onChange={e => setSubtitleY(Number(e.target.value))} className="flex-1 accent-indigo-500 cursor-pointer" />
                  <span className="text-[10px] font-bold text-indigo-400 w-8 text-right">{subtitleY}%</span>
                </div>
              </div>
            )}

            {/* STEP 3: Process Button */}
            {videoSrc && status !== 'completed' && (
              <div className="bg-[#0A0A0A] border border-slate-800/60 rounded-3xl p-8">
                <div className="flex items-center gap-3 mb-6">
                  <span className="bg-indigo-600 text-white text-[10px] font-black w-6 h-6 flex items-center justify-center rounded-full">3</span>
                  <h2 className="text-sm font-black uppercase tracking-widest">Proses</h2>
                </div>

                <button
                  onClick={processViralClips}
                  disabled={status === 'processing'}
                  className="w-full bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white font-black py-5 rounded-2xl text-sm uppercase tracking-wider shadow-xl active:scale-[0.98] transition-all flex items-center justify-center gap-3 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  {status === 'processing' ? (
                    <><Loader2 className="animate-spin" size={20} /> MEMPROSES...</>
                  ) : (
                    <><Sparkles size={20} /> JADIKAN CLIP VIRAL</>
                  )}
                </button>

                {/* Progress */}
                {status === 'processing' && (
                  <div className="mt-6 p-5 bg-black/60 border border-slate-800 rounded-2xl space-y-3">
                    <div className="flex justify-between items-center">
                      <div>
                        <p className="text-[10px] font-black uppercase tracking-widest text-indigo-400">{progress.step}</p>
                        <p className="text-[9px] text-slate-500 mt-0.5">{progress.detail}</p>
                      </div>
                      <span className="text-xs font-black text-indigo-400">{progress.percent}%</span>
                    </div>
                    <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                      <div className="h-full bg-indigo-500 shadow-[0_0_15px_rgba(99,102,241,0.5)] transition-all duration-500 rounded-full" style={{ width: `${progress.percent}%` }} />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* STEP 4: Results - Individual Clip Boxes */}
            {status === 'completed' && exportedClips.length > 0 && (
              <div className="bg-[#0A0A0A] border border-green-800/40 rounded-3xl p-8">
                <div className="flex items-center gap-3 mb-6">
                  <CheckCircle2 size={20} className="text-green-400" />
                  <h2 className="text-sm font-black uppercase tracking-widest text-green-400">{exportedClips.length} Clip Siap!</h2>
                </div>
                <p className="text-xs text-slate-500 mb-6">Preview clip tanpa subtitle. Klik "Generate Subtitle" untuk menambahkan teks, lalu unduh.</p>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {exportedClips.map((clip, idx) => (
                    <div key={clip.id} className="bg-black/60 border border-slate-800 rounded-2xl overflow-hidden flex flex-col">
                      {/* Video Preview */}
                      <div className="relative aspect-[9/16] bg-black">
                        <video
                          src={clip.subtitledUrl || clip.url}
                          className="absolute inset-0 w-full h-full object-cover"
                          controls
                          muted
                          preload="metadata"
                        />
                      </div>

                      {/* Info & Actions */}
                      <div className="p-4 flex flex-col gap-3">
                        <div>
                          <div className="flex items-center justify-between">
                            <p className="text-xs font-black text-slate-200 truncate flex-1">Clip {clip.id}: {clip.title}</p>
                            {clip.viralScore != null && (
                              <span className={`shrink-0 ml-2 flex items-center gap-1 text-[10px] font-black px-2 py-0.5 rounded-full ${
                                clip.viralScore >= 80 ? 'bg-green-500/20 text-green-400' :
                                clip.viralScore >= 50 ? 'bg-yellow-500/20 text-yellow-400' :
                                'bg-red-500/20 text-red-400'
                              }`}>
                                <TrendingUp size={10} /> {clip.viralScore}
                              </span>
                            )}
                          </div>
                          <p className="text-[9px] text-slate-600 mt-0.5">{clip.filename}</p>
                        </div>

                        {clip.subtitleStatus === 'idle' && (
                          <div className="space-y-2">
                            <div className="flex items-center gap-2">
                              <Type size={10} className="text-slate-500 shrink-0" />
                              <span className="text-[8px] font-black uppercase tracking-widest text-slate-500 shrink-0">Size</span>
                              <input type="range" min={12} max={36} value={clip.clipSubSize ?? subtitleSize}
                                onChange={e => { const v = Number(e.target.value); setExportedClips(prev => prev.map((c, i) => i === idx ? { ...c, clipSubSize: v } : c)); }}
                                className="flex-1 accent-indigo-500 cursor-pointer h-1" />
                              <span className="text-[9px] font-bold text-indigo-400 w-4 text-right">{clip.clipSubSize ?? subtitleSize}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <MoveVertical size={10} className="text-slate-500 shrink-0" />
                              <span className="text-[8px] font-black uppercase tracking-widest text-slate-500 shrink-0">Y Pos</span>
                              <input type="range" min={0} max={100} value={clip.clipSubY ?? subtitleY}
                                onChange={e => { const v = Number(e.target.value); setExportedClips(prev => prev.map((c, i) => i === idx ? { ...c, clipSubY: v } : c)); }}
                                className="flex-1 accent-indigo-500 cursor-pointer h-1" />
                              <span className="text-[9px] font-bold text-indigo-400 w-6 text-right">{clip.clipSubY ?? subtitleY}%</span>
                            </div>
                            <button
                              onClick={() => generateSubtitle(idx)}
                              className="w-full flex items-center justify-center gap-2 text-[10px] font-black uppercase tracking-wider bg-indigo-600 hover:bg-indigo-500 text-white py-2.5 rounded-xl transition-colors"
                            >
                              <Type size={14} /> Generate Subtitle
                            </button>
                          </div>
                        )}

                        {clip.subtitleStatus === 'processing' && (
                          <div className="space-y-2">
                            <div className="flex items-center justify-center gap-2 text-[10px] font-black uppercase tracking-wider text-indigo-400 py-2.5">
                              <Loader2 size={14} className="animate-spin" /> Menambahkan subtitle...
                            </div>
                            <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                              <div className="h-full bg-indigo-500 transition-all duration-300 rounded-full" style={{ width: `${clip.subProgress}%` }} />
                            </div>
                          </div>
                        )}

                        {clip.subtitleStatus === 'done' && (
                          <a
                            href={clip.subtitledUrl}
                            download={clip.subtitledFilename}
                            className="w-full flex items-center justify-center gap-2 text-[10px] font-black uppercase tracking-wider bg-green-600 hover:bg-green-500 text-white py-2.5 rounded-xl transition-colors"
                          >
                            <Download size={14} /> Simpan Video
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                <button
                  onClick={() => { setExportedClips([]); setStatus('idle'); }}
                  className="mt-6 w-full py-3 rounded-xl text-[10px] font-black uppercase tracking-widest bg-slate-900 border border-slate-800 hover:border-slate-600 transition-colors text-slate-400"
                >
                  BUAT CLIP BARU
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <footer className="max-w-5xl mx-auto mt-16 pb-12 border-t border-slate-900/50 pt-8 text-center opacity-10 text-[9px] font-black uppercase tracking-[0.5em] text-slate-500">
        <p>CLIPPER.PRO // LOCAL AI ENGINE v7.0</p>
      </footer>
    </div>
  );
}