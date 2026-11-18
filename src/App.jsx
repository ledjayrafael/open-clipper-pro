import React, { useState, useEffect, useRef } from 'react';
import {
  UploadCloud, FileVideo, Sparkles, Download, Play, Pause,
  CheckCircle2, Loader2, Cpu, ShieldCheck, Trash2,
  Volume2, VolumeX, Type, MoveVertical, Save, TrendingUp
} from 'lucide-react';

const readPref = (key, fallback) => {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
};
const writePref = (key, value) => {
  try { if (value) localStorage.setItem(key, value); } catch { /* storage unavailable */ }
};

// Clip length presets in seconds; the backend enforces them on the AI's picks.
const LENGTH_PRESETS = [
  { id: 'short', label: '15–30 dtk', min: 15, max: 30 },
  { id: 'medium', label: '30–60 dtk', min: 30, max: 60 },
  { id: 'long', label: '60–90 dtk', min: 60, max: 90 },
];

export default function App() {
  const [videoFile, setVideoFile] = useState(null);
  const [videoSrc, setVideoSrc] = useState(null);
  const [subtitleSize, setSubtitleSize] = useState(22);
  const [subtitleY, setSubtitleY] = useState(0);
  const [status, setStatus] = useState('idle');
  const [faceDetection, setFaceDetection] = useState(true);
  const [ffmpegLoaded, setFfmpegLoaded] = useState(false);
  const [progress, setProgress] = useState({ step: '', detail: '', percent: 0 });
  const [exportedClips, setExportedClips] = useState([]);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [engineMode, setEngineMode] = useState('checking');
  const [aiProviders, setAiProviders] = useState(null);
  const [aiProvider, setAiProvider] = useState(() => readPref('clipper.aiProvider', ''));
  const [ollamaModel, setOllamaModel] = useState(() => readPref('clipper.ollamaModel', ''));
  const [clipCount, setClipCount] = useState(() => Number(readPref('clipper.clipCount', '5')) || 5);
  const [clipLength, setClipLength] = useState(() => readPref('clipper.clipLength', 'medium'));
  const [analysisInfo, setAnalysisInfo] = useState(null);

  const videoRef = useRef(null);

  // AI providers (OpenRouter / Ollama) available on the backend
  useEffect(() => {
    fetch('/api/ai-providers')
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (!data?.ok) return;
        setAiProviders(data);
        setAiProvider(prev => {
          if (prev && data[prev]?.available) return prev;
          if (data[data.default]?.available) return data.default;
          return data.openrouter.available ? 'openrouter' : data.ollama.available ? 'ollama' : (prev || data.default);
        });
        setOllamaModel(prev => (data.ollama.models.includes(prev) ? prev : data.ollama.defaultModel));
      })
      .catch(() => {});
  }, []);

  useEffect(() => { writePref('clipper.aiProvider', aiProvider); }, [aiProvider]);
  useEffect(() => { writePref('clipper.ollamaModel', ollamaModel); }, [ollamaModel]);
  useEffect(() => { writePref('clipper.clipCount', String(clipCount)); }, [clipCount]);
  useEffect(() => { writePref('clipper.clipLength', clipLength); }, [clipLength]);

  const aiLabel = aiProvider === 'ollama' ? `Ollama · ${ollamaModel || 'lokal'}` : 'OpenRouter';

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
    setAnalysisInfo(null);

    try {
      // The backend transcribes the video, asks the AI and cuts the clips in one job.
      // API keys stay on the server; the browser only sends the video and settings.
      const preset = LENGTH_PRESETS.find(p => p.id === clipLength) || LENGTH_PRESETS[1];
      setProgress({ step: 'Upload video', detail: `Mengirim ke server lokal (${aiLabel})...`, percent: 1 });
      const formData = new FormData();
      formData.append('video', videoFile);
      formData.append('face_detection', faceDetection ? '1' : '0');
      formData.append('provider', aiProvider || '');
      if (aiProvider === 'ollama' && ollamaModel) formData.append('model', ollamaModel);
      formData.append('clip_count', String(clipCount));
      formData.append('min_duration', String(preset.min));
      formData.append('max_duration', String(preset.max));

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
          if (result.ok) { setAnalysisInfo(result.analysis || null); resolve(result.clips); }
          else reject(new Error(result.error || 'Processing gagal.'));
        });

        evtSource.onerror = () => {
          evtSource.close();
          reject(new Error('Koneksi ke server terputus.'));
        };
      });

      setProgress({ step: 'Pemotongan selesai', detail: `${clips.length} clip siap di-preview`, percent: 100 });
      setExportedClips(clips.map(c => ({
        ...c,
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
        <header className="mb-10 flex flex-col items-center text-center">
          <img src="/openclipper.png" alt="" width="95" height="96" className="h-20 md:h-24 w-auto mb-3 drop-shadow-[0_8px_24px_rgba(255,255,255,0.12)]" />
          <h1 className="text-4xl md:text-6xl font-black tracking-tighter text-white leading-none">
            Open Clipper <span className="text-indigo-400">Pro</span>
          </h1>
          <p className="text-slate-500 font-bold mt-3 uppercase tracking-[0.2em] text-[10px]">AI Viral Clip Generator // Local Processing</p>
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

            {/* AI mode: always visible so it can be chosen before upload */}
            <div className="bg-[#0A0A0A] border border-slate-800/60 rounded-3xl p-6">
              <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2">Mode AI</p>
              <div role="radiogroup" aria-label="Mode AI" className="grid grid-cols-2 gap-2 p-1 bg-slate-900/60 border border-slate-800 rounded-xl">
                {[
                  { id: 'openrouter', label: 'OpenRouter', hint: 'Cloud', off: 'Key belum diset' },
                  { id: 'ollama', label: 'Ollama', hint: 'Lokal', off: aiProviders?.ollama.running ? 'Belum ada model' : 'Tidak terdeteksi' },
                ].map(opt => {
                  const available = aiProviders ? aiProviders[opt.id].available : true;
                  const active = aiProvider === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      disabled={!available || status === 'processing'}
                      onClick={() => setAiProvider(opt.id)}
                      title={available ? undefined : opt.off}
                      className={`py-2.5 px-3 rounded-lg text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${active ? 'bg-indigo-600 text-white' : 'text-slate-300 hover:bg-slate-800'}`}
                    >
                      <span className="block text-xs font-black">{opt.label}</span>
                      <span className={`block text-[10px] font-bold ${active ? 'text-indigo-200' : 'text-slate-500'}`}>
                        {available ? opt.hint : opt.off}
                      </span>
                    </button>
                  );
                })}
              </div>
              {aiProvider === 'ollama' && aiProviders?.ollama.models.length > 0 && (
                <div className="mt-3">
                  <label htmlFor="ollama-model" className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1">Model lokal</label>
                  <select
                    id="ollama-model"
                    value={ollamaModel}
                    onChange={e => setOllamaModel(e.target.value)}
                    disabled={status === 'processing'}
                    className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm font-bold text-slate-200 focus:outline-none focus:border-indigo-500"
                  >
                    {aiProviders.ollama.models.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <p className="mt-1 text-[10px] text-slate-500">Model lokal lebih lambat; analisis bisa makan 1–3 menit.</p>
                </div>
              )}
            </div>

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

                {/* Subtitle preview removed before processing; per-clip subtitle controls remain in STEP 4 */}
              </div>
            )}

            {/* STEP 3: Process Button */}
            {videoSrc && status !== 'completed' && (
              <div className="bg-[#0A0A0A] border border-slate-800/60 rounded-3xl p-8">
                <div className="flex items-center gap-3 mb-6">
                  <span className="bg-indigo-600 text-white text-[10px] font-black w-6 h-6 flex items-center justify-center rounded-full">3</span>
                  <h2 className="text-sm font-black uppercase tracking-widest">Proses</h2>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-5">
                  <div>
                    <label htmlFor="clip-count" className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1">Jumlah clip</label>
                    <select
                      id="clip-count"
                      value={clipCount}
                      onChange={e => setClipCount(Number(e.target.value))}
                      disabled={status === 'processing'}
                      className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm font-bold text-slate-200 focus:outline-none focus:border-indigo-500"
                    >
                      {Array.from({ length: 10 }, (_, i) => i + 1).map(n => <option key={n} value={n}>{n} clip</option>)}
                    </select>
                  </div>
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1">Durasi per clip</p>
                    <div role="radiogroup" aria-label="Durasi per clip" className="grid grid-cols-3 gap-1 p-1 bg-slate-900/60 border border-slate-800 rounded-lg">
                      {LENGTH_PRESETS.map(p => (
                        <button
                          key={p.id}
                          type="button"
                          role="radio"
                          aria-checked={clipLength === p.id}
                          disabled={status === 'processing'}
                          onClick={() => setClipLength(p.id)}
                          className={`py-1.5 rounded-md text-[11px] font-black transition-colors disabled:opacity-40 ${clipLength === p.id ? 'bg-indigo-600 text-white' : 'text-slate-300 hover:bg-slate-800'}`}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-3 mb-4">
                  <input id="face-detect-toggle" type="checkbox" checked={faceDetection} onChange={e => setFaceDetection(e.target.checked)} className="w-4 h-4 accent-indigo-500" />
                  <label htmlFor="face-detect-toggle" className="text-sm font-black text-slate-300">Auto Face Detection</label>
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
                <p className="text-xs text-slate-500 mb-3">Preview clip tanpa subtitle. Klik "Generate Subtitle" untuk menambahkan teks, lalu unduh.</p>
                {analysisInfo && (
                  analysisInfo.source === 'transcript' ? (
                    <p className="text-[11px] text-slate-500 mb-6">
                      Dipilih AI dari transkrip {analysisInfo.words.toLocaleString('id-ID')} kata
                      {analysisInfo.stats ? ` (${analysisInfo.stats.received} kandidat diperiksa)` : ''}.
                    </p>
                  ) : (
                    <p className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3 mb-6">
                      {analysisInfo.notice || 'AI hanya melihat durasi video, bukan isinya.'}
                    </p>
                  )
                )}

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
                          {clip.start != null && (
                            <p className="text-[10px] font-mono text-slate-500 mt-0.5">{fmt(clip.start)}–{fmt(clip.end)} · {Math.round(clip.duration)} dtk</p>
                          )}
                          {clip.reason && <p className="text-[11px] text-slate-400 mt-1.5 leading-snug">{clip.reason}</p>}
                          <p className="text-[9px] text-slate-600 mt-1 truncate">{clip.filename}</p>
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
        <p>OPEN CLIPPER PRO // LOCAL AI ENGINE v7.0</p>
      </footer>
    </div>
  );
}