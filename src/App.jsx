import React, { useState, useEffect, useRef } from 'react';
import {
  UploadCloud, FileVideo, Sparkles, Download, Play, Pause,
  Loader2, Cpu, ShieldCheck, Trash2,
  Volume2, VolumeX, Type, MoveVertical, TrendingUp, RotateCcw, Bot
} from 'lucide-react';
import HighlightReview from './components/HighlightReview';
import Library from './components/Library';
import AnalysisOptions from './components/AnalysisOptions';
import { LENGTH_PRESETS, presetFor, REFRAME_OPTIONS, scoreClass } from './lib/options';
import { Card, StepHeader, FieldLabel, Segmented, ProgressPanel, Notice, primaryButton, secondaryButton, fieldClass } from './components/ui';

// Default subtitle look; each clip can override it before burning in.
const subtitleSize = 22;
const subtitleY = 0;

const readPref = (key, fallback) => {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
};
const writePref = (key, value) => {
  try { if (value) localStorage.setItem(key, value); } catch { /* storage unavailable */ }
};

export default function App() {
  const [videoFile, setVideoFile] = useState(null);
  const [videoSrc, setVideoSrc] = useState(null);
  const [status, setStatus] = useState('idle');
  const [reframeMode, setReframeMode] = useState(() => readPref('clipper.reframe', 'track'));
  const [karaoke, setKaraoke] = useState(() => readPref('clipper.karaoke', '1') === '1');
  const [ffmpegLoaded, setFfmpegLoaded] = useState(false);
  const [progress, setProgress] = useState({ step: '', detail: '', percent: 0 });
  const [exportedClips, setExportedClips] = useState([]);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [engineMode, setEngineMode] = useState('checking');
  const [encoderLabel, setEncoderLabel] = useState('');
  const [aiProviders, setAiProviders] = useState(null);
  const [aiProvider, setAiProvider] = useState(() => readPref('clipper.aiProvider', ''));
  const [ollamaModel, setOllamaModel] = useState(() => readPref('clipper.ollamaModel', ''));
  const [clipCount, setClipCount] = useState(() => Number(readPref('clipper.clipCount', '5')) || 5);
  const [clipLength, setClipLength] = useState(() => readPref('clipper.clipLength', 'medium'));
  const [direction, setDirection] = useState('');
  const [hookEnabled, setHookEnabled] = useState(() => readPref('clipper.hook', '1') === '1');
  const [session, setSession] = useState(null);
  const [drafts, setDrafts] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [notice, setNotice] = useState(null);

  const videoRef = useRef(null);
  const previewEndRef = useRef(null);

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
          return ['openrouter', 'ollama', 'custom'].find(id => data[id]?.available) || prev || data.default;
        });
        setOllamaModel(prev => (data.ollama?.models?.includes(prev) ? prev : data.ollama?.defaultModel || ''));
      })
      .catch(() => {});
  }, []);

  useEffect(() => { writePref('clipper.aiProvider', aiProvider); }, [aiProvider]);
  useEffect(() => { writePref('clipper.ollamaModel', ollamaModel); }, [ollamaModel]);
  useEffect(() => { writePref('clipper.clipCount', String(clipCount)); }, [clipCount]);
  useEffect(() => { writePref('clipper.clipLength', clipLength); }, [clipLength]);
  useEffect(() => { writePref('clipper.hook', hookEnabled ? '1' : '0'); }, [hookEnabled]);
  useEffect(() => { writePref('clipper.reframe', reframeMode); }, [reframeMode]);
  useEffect(() => { writePref('clipper.karaoke', karaoke ? '1' : '0'); }, [karaoke]);

  const aiLabel = aiProvider === 'ollama' ? `Ollama · ${ollamaModel || 'lokal'}`
    : aiProvider === 'custom' ? `${aiProviders?.custom?.name || 'Custom'} · ${aiProviders?.custom?.model || ''}`
    : 'OpenRouter';

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
        setEncoderLabel(payload.encoder || '');
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
    const sync = () => {
      setCurrentTime(v.currentTime);
      // Highlight preview: stop at the end of the span being previewed.
      if (previewEndRef.current !== null && v.currentTime >= previewEndRef.current) {
        previewEndRef.current = null;
        v.pause();
      }
    };
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
    previewEndRef.current = null;
    videoRef.current.currentTime = Number(e.target.value);
  };

  const fmt = (s) => {
    const mm = Math.floor((s || 0) / 60).toString().padStart(2, '0');
    const ss = Math.floor((s || 0) % 60).toString().padStart(2, '0');
    return `${mm}:${ss}`;
  };

  // Follow a backend job over SSE until it finishes; resolves with its result.
  const followJob = (jobId, onProgress) => new Promise((resolve, reject) => {
    const evtSource = new EventSource(`/api/progress/${jobId}`);
    evtSource.addEventListener('progress', (e) => onProgress?.(JSON.parse(e.data)));
    evtSource.addEventListener('done', (e) => {
      evtSource.close();
      const result = JSON.parse(e.data);
      if (result.ok) resolve(result);
      else reject(new Error(result.error || 'Processing gagal.'));
    });
    evtSource.onerror = () => {
      evtSource.close();
      reject(new Error('Koneksi ke server terputus.'));
    };
  });

  const postJson = async (url, body) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw new Error(payload.error || `Request gagal (${response.status}).`);
    return payload;
  };

  const refreshLibrary = () => {
    fetch('/api/sessions')
      .then(r => (r.ok ? r.json() : null))
      .then(data => { if (data?.ok) setSessions(data.sessions); })
      .catch(() => {});
  };
  useEffect(refreshLibrary, []);

  const toUiClip = (clip) => ({
    ...clip,
    subtitleStatus: clip.subtitledUrl ? 'done' : 'idle',
    subProgress: clip.subtitledUrl ? 100 : 0,
    clipSubSize: subtitleSize,
    clipSubY: subtitleY,
  });

  // Load a session's candidates and clips into the UI.
  const applySession = (next) => {
    setSession(next);
    setDrafts(next.candidates.map(c => ({
      id: c.id, selected: c.selected, start: c.start, end: c.end,
      title: c.title, hookText: c.hookText || '', reason: c.reason,
      viralScore: c.viralScore, requested: c.requested,
    })));
    setExportedClips([...next.clips].reverse().map(toUiClip));
    if (next.settings?.direction !== undefined) setDirection(next.settings.direction);
  };

  const analysisSettings = () => {
    const preset = LENGTH_PRESETS.find(p => p.id === clipLength) || LENGTH_PRESETS[1];
    return {
      provider: aiProvider || '',
      model: aiProvider === 'ollama' ? ollamaModel || '' : '',
      clip_count: String(clipCount),
      min_duration: String(preset.min),
      max_duration: String(preset.max),
      direction: direction.trim(),
    };
  };

  // 3. Analysis: upload a new video, or re-run the AI on the open session's transcript.
  const startAnalysis = async () => {
    if (!videoFile && !session) return;
    if (!ffmpegLoaded) {
      setNotice({ title: 'Server lokal belum aktif', message: 'Jalankan npm run dev:server di terminal terpisah, lalu refresh halaman.' });
      return;
    }
    setNotice(null);

    const previousStatus = status;
    setStatus('analyzing');
    const settings = analysisSettings();
    try {
      let jobId;
      if (session) {
        setProgress({ step: `Analisis ulang (${aiLabel})`, detail: 'Memakai transkrip yang sudah ada...', percent: 5 });
        ({ jobId } = await postJson(`/api/sessions/${session.id}/analyze`, settings));
      } else {
        setProgress({ step: 'Upload video', detail: `Mengirim ke server lokal (${aiLabel})...`, percent: 1 });
        const formData = new FormData();
        formData.append('video', videoFile);
        Object.entries(settings).forEach(([key, value]) => formData.append(key, value));
        const response = await fetch('/api/sessions', { method: 'POST', body: formData });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.ok) throw new Error(payload.error || 'Upload gagal.');
        jobId = payload.jobId;
      }

      const result = await followJob(jobId, data => setProgress({ step: data.step, detail: data.detail, percent: data.percent }));
      applySession(result.session);
      setStatus('review');
      refreshLibrary();
    } catch (err) {
      console.error('Analysis Error:', err);
      setStatus(previousStatus === 'analyzing' ? 'idle' : previousStatus);
      setNotice({ title: 'Analisis gagal', message: err.message });
    }
  };

  // 4. Render the highlights the user picked, with their edits.
  const renderSelected = async () => {
    if (!session) return;
    const items = drafts.filter(d => d.selected).map(d => ({
      id: d.id, start: d.start, end: d.end, title: d.title, hookText: d.hookText,
    }));
    setNotice(null);
    setStatus('rendering');
    setProgress({ step: 'Render clip', detail: `Menyiapkan ${items.length} clip...`, percent: 0 });
    try {
      const { jobId } = await postJson(`/api/sessions/${session.id}/render`, { items, reframe: reframeMode, hook: hookEnabled });
      const result = await followJob(jobId, data => setProgress({ step: data.step, detail: data.detail, percent: data.percent }));
      applySession(result.session);
      setStatus('completed');
      refreshLibrary();
    } catch (err) {
      console.error('Render Error:', err);
      setStatus('review');
      setNotice({ title: 'Render gagal', message: err.message });
    }
  };

  // Seek the source preview to a highlight and stop at its end.
  const previewSpan = (start, end) => {
    const v = videoRef.current;
    if (!v) return;
    previewEndRef.current = end;
    v.currentTime = start;
    v.play().catch(() => {});
    v.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const resetAll = () => {
    if (videoSrc?.startsWith('blob:')) URL.revokeObjectURL(videoSrc);
    setVideoFile(null);
    setVideoSrc(null);
    setSession(null);
    setDrafts([]);
    setExportedClips([]);
    setDirection('');
    setNotice(null);
    setStatus('idle');
  };

  // Bring back the settings an earlier session was analysed with.
  const restoreSettings = (settings) => {
    if (!settings) return;
    if (settings.count) setClipCount(settings.count);
    const preset = presetFor(settings.minDur, settings.maxDur);
    if (preset) setClipLength(preset);
    if (settings.provider && aiProviders?.[settings.provider]?.available) setAiProvider(settings.provider);
    if (settings.provider === 'ollama' && aiProviders?.ollama?.models?.includes(settings.model)) setOllamaModel(settings.model);
  };

  const openSession = async (id) => {
    try {
      const response = await fetch(`/api/sessions/${id}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || 'Session tidak bisa dibuka.');
      if (videoSrc?.startsWith('blob:')) URL.revokeObjectURL(videoSrc);
      setVideoFile(null);
      setVideoSrc(payload.session.videoUrl);
      applySession(payload.session);
      restoreSettings(payload.session.settings);
      setNotice(null);
      setStatus(payload.session.clips.length ? 'completed' : payload.session.candidates.length ? 'review' : 'idle');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setNotice({ title: 'Riwayat tidak bisa dibuka', message: err.message });
    }
  };

  const deleteSessionItem = async (item) => {
    if (!window.confirm(`Hapus "${item.name}" beserta ${item.clips} clip-nya? Ini tidak bisa dibatalkan.`)) return;
    try {
      const response = await fetch(`/api/sessions/${item.id}`, { method: 'DELETE' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || 'Gagal menghapus.');
      if (session?.id === item.id) resetAll();
      refreshLibrary();
    } catch (err) {
      setNotice({ title: 'Gagal menghapus', message: err.message });
    }
  };

  const patchClip = (clipIndex, patch) =>
    setExportedClips(prev => prev.map((c, i) => (i === clipIndex ? { ...c, ...patch } : c)));

  // Generate subtitle for a single clip
  const generateSubtitle = async (clipIndex) => {
    const clip = exportedClips[clipIndex];
    if (!clip || clip.subtitleStatus === 'processing') return;

    setExportedClips(prev => prev.map((c, i) => i === clipIndex ? { ...c, subtitleStatus: 'processing', subProgress: 0 } : c));

    try {
      const { jobId } = await postJson('/api/add-subtitle', {
        clipFilename: clip.filename,
        captions: clip.captions,
        subtitleSize: clip.clipSubSize ?? subtitleSize,
        subtitleY: clip.clipSubY ?? subtitleY,
        clipDuration: clip.duration,
        sessionId: session?.id,
        style: karaoke ? 'karaoke' : 'plain',
      });
      const result = await followJob(jobId, data => {
        setExportedClips(prev => prev.map((c, i) => i === clipIndex ? { ...c, subProgress: data.percent } : c));
      });
      setExportedClips(prev => prev.map((c, i) => i === clipIndex ? {
        ...c, subtitleStatus: 'done', subProgress: 100,
        subtitledUrl: result.url, subtitledFilename: result.filename,
      } : c));
    } catch (err) {
      console.error('Subtitle Error:', err);
      patchClip(clipIndex, { subtitleStatus: clip.subtitledUrl ? 'done' : 'idle', subProgress: 0 });
      setNotice({ title: `Subtitle "${clip.title}" gagal`, message: err.message });
    }
  };

  const busy = status === 'analyzing' || status === 'rendering';
  const sourceName = videoFile?.name || session?.name || '';
  const reframeLabel = (id) => REFRAME_OPTIONS.find(o => o.id === id)?.label || id;
  const providerOptions = [
    { id: 'openrouter', label: 'OpenRouter', hint: 'Cloud', off: 'Key belum diset' },
    { id: 'ollama', label: 'Ollama', hint: 'Lokal', off: aiProviders?.ollama?.running ? 'Belum ada model' : 'Tidak terdeteksi' },
    // OpenAI-compatible endpoint from .env; only shown once configured.
    ...(aiProviders?.custom?.available ? [{
      id: 'custom', label: aiProviders.custom.name, hint: aiProviders.custom.model, off: '',
      title: aiProviders.custom.host ? `${aiProviders.custom.model} di ${aiProviders.custom.host}` : undefined,
    }] : []),
  ].map(opt => {
    const available = aiProviders ? Boolean(aiProviders[opt.id]?.available) : true;
    return { ...opt, disabled: !available, hint: available ? opt.hint : opt.off, title: available ? opt.title : opt.off };
  });
  const analysisOptions = { clipCount, setClipCount, clipLength, setClipLength, direction, setDirection };

  return (
    <div className="min-h-screen bg-[#050505] text-slate-100 font-sans">
      {/* Status bar: what will do the work */}
      <div className="w-full bg-indigo-600/10 border-b border-indigo-500/10 px-4 sm:px-6 py-2 flex flex-wrap gap-x-4 gap-y-1 justify-between items-center text-[10px] font-black tracking-widest text-indigo-300 uppercase">
        <span className="flex items-center gap-2">
          <ShieldCheck size={14} /> Local processing
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex items-center gap-1.5" title="Model AI yang dipakai untuk memilih highlight">
            <Bot size={12} className="text-slate-400" /> {aiProvider ? aiLabel : 'AI belum dipilih'}
          </span>
          <span className="flex items-center gap-1.5">
            <Cpu size={12} className={ffmpegLoaded ? 'text-green-400' : 'text-slate-500'} />
            {ffmpegLoaded ? engineMode : 'offline'}
            {ffmpegLoaded && encoderLabel && <span className="text-slate-400">· {encoderLabel}</span>}
          </span>
        </span>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-8 sm:p-6 md:p-12">
        <header className="mb-10 flex flex-col items-center text-center">
          <img src="/openclipper.png" alt="" width="95" height="96" className="h-20 md:h-24 w-auto mb-3 drop-shadow-[0_8px_24px_rgba(255,255,255,0.12)]" />
          <h1 className="text-4xl md:text-6xl font-black tracking-tight text-white leading-none text-balance">
            Open Clipper <span className="text-indigo-400">Pro</span>
          </h1>
          <p className="text-slate-400 font-bold mt-3 text-sm">Video panjang jadi clip vertikal 9:16, dipilih AI dari transkripnya.</p>
        </header>

        {status === 'loading-lib' ? (
          <div className="py-32 text-center" role="status">
            <Loader2 className="w-12 h-12 animate-spin text-indigo-500 mx-auto mb-6" />
            <p className="text-slate-400 text-xs font-bold uppercase tracking-widest">{progress.step}</p>
            <p className="text-slate-500 text-[11px] mt-2">Pertama kali, server juga mengetes encoder video.</p>
          </div>
        ) : (
          <div className="space-y-6 sm:space-y-8">

            {engineMode === 'offline' && (
              <div className="bg-amber-500/10 border border-amber-500/20 rounded-2xl p-5">
                <p className="text-xs font-black text-amber-200">Server FFmpeg lokal belum aktif</p>
                <p className="text-xs text-slate-300 mt-1.5">Jalankan <code className="font-mono text-amber-200">npm run dev:server</code> di terminal terpisah, lalu refresh halaman.</p>
              </div>
            )}

            {notice && <Notice title={notice.title} message={notice.message} onClose={() => setNotice(null)} />}

            {/* AI mode: always visible so it can be chosen before upload */}
            <Card className="!p-5 sm:!p-6">
              <FieldLabel>Model AI untuk memilih highlight</FieldLabel>
              <Segmented
                label="Mode AI"
                options={providerOptions}
                value={aiProvider}
                onChange={setAiProvider}
                disabled={busy}
              />
              {aiProvider === 'ollama' && aiProviders?.ollama?.models?.length > 0 && (
                <div className="mt-4">
                  <FieldLabel htmlFor="ollama-model">Model lokal</FieldLabel>
                  <select
                    id="ollama-model"
                    value={ollamaModel}
                    onChange={e => setOllamaModel(e.target.value)}
                    disabled={busy}
                    className={fieldClass}
                  >
                    {aiProviders.ollama.models.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <p className="mt-1.5 text-[11px] text-slate-500">Model lokal lebih lambat; analisis bisa makan 1–3 menit.</p>
                </div>
              )}
              {aiProviders && !providerOptions.some(o => !o.disabled) && (
                <p className="mt-3 text-[11px] text-amber-200">
                  Belum ada AI yang siap. Isi <code className="font-mono">OPENROUTER_API_KEY</code> di <code className="font-mono">.env</code>, jalankan Ollama, atau set <code className="font-mono">CUSTOM_AI_*</code>.
                </p>
              )}
            </Card>

            {/* STEP 1: Video */}
            <Card>
              <StepHeader step={1} title="Pilih Video" />
              {!videoSrc ? (
                <label className="block border-2 border-dashed border-slate-800 rounded-2xl p-10 text-center relative group hover:border-indigo-500/50 focus-within:border-indigo-500 transition-colors cursor-pointer">
                  <input type="file" accept="video/*" className="absolute inset-0 opacity-0 cursor-pointer z-10" onChange={(e) => {
                    const file = e.target.files[0];
                    if (file) {
                      resetAll();
                      setVideoFile(file);
                      setVideoSrc(URL.createObjectURL(file));
                    }
                  }} />
                  <UploadCloud className="mx-auto mb-3 text-slate-600 group-hover:text-indigo-400 transition-colors" size={44} />
                  <span className="block text-sm font-bold text-slate-300">Klik atau tarik video ke sini</span>
                  <span className="block text-[11px] text-slate-500 mt-1">MP4, MOV, AVI, WebM · sesi lama ada di Riwayat di bawah</span>
                </label>
              ) : (
                <div className="flex items-center justify-between gap-3 p-4 bg-black/60 border border-slate-800 rounded-xl">
                  <div className="flex items-center gap-3 min-w-0">
                    <FileVideo className="text-indigo-400 shrink-0" size={22} />
                    <div className="min-w-0">
                      <p className="text-xs font-bold truncate text-slate-200">{sourceName}</p>
                      <p className="text-[11px] text-slate-500 mt-0.5 tabular-nums">
                        {videoFile ? `${(videoFile.size / (1024 * 1024)).toFixed(1)} MB` : 'Dari riwayat'}
                        {videoDuration > 0 && ` · ${fmt(videoDuration)}`}
                        {session?.transcriptWords > 0 && ` · transkrip ${session.transcriptWords.toLocaleString('id-ID')} kata`}
                      </p>
                    </div>
                  </div>
                  <button type="button" onClick={resetAll} disabled={busy} aria-label="Tutup video" title="Tutup video" className="text-slate-500 hover:text-red-400 p-2 disabled:opacity-40"><Trash2 size={18} /></button>
                </div>
              )}
            </Card>

            {/* STEP 2: Source preview */}
            {videoSrc && (
              <Card>
                <StepHeader
                  step={2}
                  title="Preview"
                  aside={(
                    <button
                      type="button"
                      onClick={() => setIsMuted(!isMuted)}
                      aria-label={isMuted ? 'Nyalakan suara' : 'Matikan suara'}
                      aria-pressed={isMuted}
                      className="p-2 bg-slate-900 border border-slate-800 rounded-lg text-slate-300 hover:text-indigo-300 transition-colors"
                    >
                      {isMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
                    </button>
                  )}
                />

                <div className="flex justify-center">
                  <div className="relative w-full max-w-[300px] aspect-[9/16] bg-black rounded-2xl overflow-hidden border border-slate-800 shadow-2xl shadow-black/60 group">
                    <video src={videoSrc} className="absolute inset-0 h-full w-full object-cover opacity-15 blur-2xl scale-125" muted loop autoPlay aria-hidden="true" />
                    <video ref={videoRef} src={videoSrc} muted={isMuted} playsInline className="absolute inset-0 h-full w-full object-cover" />
                    <button
                      type="button"
                      onClick={togglePlay}
                      aria-label={isPlaying ? 'Jeda' : 'Putar'}
                      className={`absolute inset-0 z-10 flex items-center justify-center transition-opacity duration-200 focus-visible:opacity-100 ${isPlaying ? 'opacity-0 group-hover:opacity-100' : 'opacity-100 bg-black/30'}`}
                    >
                      <span className="bg-white/15 backdrop-blur-md p-5 rounded-full border border-white/20">
                        {isPlaying ? <Pause className="text-white fill-white" size={30} /> : <Play className="text-white fill-white ml-1" size={30} />}
                      </span>
                    </button>
                  </div>
                </div>

                <div className="mt-5 max-w-[400px] mx-auto">
                  <input
                    type="range"
                    min={0}
                    max={videoDuration || 0}
                    step={0.1}
                    value={Math.min(currentTime, videoDuration || 0)}
                    onChange={handleSeek}
                    disabled={!videoDuration}
                    aria-label="Posisi video"
                    aria-valuetext={`${fmt(currentTime)} dari ${fmt(videoDuration)}`}
                    className="w-full h-1.5 accent-indigo-500 cursor-pointer"
                  />
                  <div className="flex justify-between text-[11px] font-mono tabular-nums text-slate-500">
                    <span>{fmt(currentTime)}</span>
                    <span>{fmt(videoDuration)}</span>
                  </div>
                </div>
              </Card>
            )}

            {/* STEP 3: Analysis settings (before the first analysis of a video) */}
            {videoSrc && drafts.length === 0 && (status === 'idle' || status === 'analyzing') && (
              <Card>
                <StepHeader step={3} title="Cari Highlight" />
                <AnalysisOptions idPrefix="analysis" disabled={busy} {...analysisOptions} />

                <button type="button" onClick={startAnalysis} disabled={busy || !aiProvider} className={`mt-6 ${primaryButton}`}>
                  {busy
                    ? <><Loader2 className="animate-spin" size={20} /> Menganalisis...</>
                    : <><Sparkles size={20} /> Cari highlight viral</>}
                </button>
                <p className="mt-2 text-[11px] text-slate-500 text-center">
                  Audio ditranskrip, lalu {aiLabel} memilih bagian terbaik. Belum ada yang dirender sampai kamu memilih.
                </p>

                {status === 'analyzing' && <div className="mt-6"><ProgressPanel progress={progress} /></div>}
              </Card>
            )}

            {/* STEP 4: Review and edit the AI's highlights before rendering */}
            {videoSrc && session && drafts.length > 0 && (status === 'review' || status === 'rendering' || status === 'analyzing') && (
              <HighlightReview
                drafts={drafts}
                setDrafts={setDrafts}
                duration={session.duration}
                analysis={session.analysis}
                fmt={fmt}
                busy={busy}
                status={status}
                progress={progress}
                onPreview={previewSpan}
                onRender={renderSelected}
                onReanalyze={startAnalysis}
                hookEnabled={hookEnabled}
                setHookEnabled={setHookEnabled}
                reframeMode={reframeMode}
                setReframeMode={setReframeMode}
                analysisOptions={analysisOptions}
                aiLabel={aiLabel}
              />
            )}

            {/* STEP 5: Rendered clips */}
            {status === 'completed' && exportedClips.length > 0 && (
              <Card tone="success">
                <StepHeader step={5} tone="success" title={`${exportedClips.length} clip siap`} />
                <p className="text-xs text-slate-400 mb-4">Clip sudah bisa diunduh tanpa subtitle. Atur ukuran dan posisi, lalu buat subtitle dari transkrip.</p>
                <label className="mb-6 flex items-center gap-3 text-sm font-black text-slate-300">
                  <input type="checkbox" checked={karaoke} onChange={e => setKaraoke(e.target.checked)} className="w-4 h-4 accent-indigo-500" />
                  Sorot kata yang sedang diucapkan (karaoke)
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {exportedClips.map((clip, idx) => (
                    <article key={clip.id} className="bg-black/60 border border-slate-800 rounded-2xl overflow-hidden flex flex-col">
                      <div className="relative aspect-[9/16] bg-black">
                        <video
                          src={clip.subtitledUrl || clip.url}
                          className="absolute inset-0 w-full h-full object-cover"
                          controls
                          muted
                          playsInline
                          preload="metadata"
                        />
                        {clip.subtitledUrl && (
                          <span className="absolute top-2 left-2 text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full bg-black/70 text-green-300">Bersubtitle</span>
                        )}
                      </div>

                      <div className="p-4 flex flex-col gap-3 flex-1">
                        <div className="flex-1">
                          <div className="flex items-start justify-between gap-2">
                            <h3 className="text-xs font-black text-slate-200 leading-snug">{clip.title}</h3>
                            {clip.viralScore != null && (
                              <span className={`shrink-0 flex items-center gap-1 text-[10px] font-black px-2 py-0.5 rounded-full tabular-nums ${scoreClass(clip.viralScore)}`}>
                                <TrendingUp size={10} /> {clip.viralScore}
                              </span>
                            )}
                          </div>
                          {clip.start != null && (
                            <p className="text-[11px] font-mono tabular-nums text-slate-500 mt-1">{fmt(clip.start)}–{fmt(clip.end)} · {Math.round(clip.duration)} dtk</p>
                          )}
                          {clip.reason && <p className="text-[11px] text-slate-400 mt-1.5 leading-snug">{clip.reason}</p>}
                          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px]">
                            {clip.reframe && (<>
                              <dt className="text-slate-500">Reframe</dt>
                              <dd className="text-slate-300 min-w-0">{reframeLabel(clip.reframe)}{clip.reframeNote && <span className="text-slate-500"> · {clip.reframeNote}</span>}</dd>
                            </>)}
                            {clip.hookText && (<>
                              <dt className="text-slate-500">Hook</dt>
                              <dd className="text-slate-300 truncate" title={clip.hookText}>{clip.hookText}</dd>
                            </>)}
                            {clip.encoder && (<>
                              <dt className="text-slate-500">Encoder</dt>
                              <dd className="text-slate-300">{clip.encoder}</dd>
                            </>)}
                          </dl>
                        </div>

                        {clip.subtitleStatus === 'idle' && (
                          <div className="space-y-2.5 pt-1">
                            <label className="flex items-center gap-2">
                              <Type size={12} className="text-slate-500 shrink-0" />
                              <span className="text-[10px] font-black uppercase tracking-widest text-slate-500 w-12 shrink-0">Ukuran</span>
                              <input type="range" min={12} max={36} value={clip.clipSubSize ?? subtitleSize}
                                onChange={e => patchClip(idx, { clipSubSize: Number(e.target.value) })}
                                className="flex-1 min-w-0 accent-indigo-500 cursor-pointer h-1" />
                              <span className="text-[11px] font-bold text-indigo-300 w-8 text-right tabular-nums">{clip.clipSubSize ?? subtitleSize}</span>
                            </label>
                            <label className="flex items-center gap-2">
                              <MoveVertical size={12} className="text-slate-500 shrink-0" />
                              <span className="text-[10px] font-black uppercase tracking-widest text-slate-500 w-12 shrink-0">Posisi</span>
                              <input type="range" min={0} max={100} value={clip.clipSubY ?? subtitleY}
                                onChange={e => patchClip(idx, { clipSubY: Number(e.target.value) })}
                                className="flex-1 min-w-0 accent-indigo-500 cursor-pointer h-1" />
                              <span className="text-[11px] font-bold text-indigo-300 w-8 text-right tabular-nums">{clip.clipSubY ?? subtitleY}%</span>
                            </label>
                            <button
                              type="button"
                              onClick={() => generateSubtitle(idx)}
                              className="w-full flex items-center justify-center gap-2 text-[11px] font-black uppercase tracking-wider bg-indigo-600 hover:bg-indigo-500 text-white py-2.5 rounded-xl transition-colors"
                            >
                              <Type size={14} /> {clip.subtitledUrl ? 'Buat ulang subtitle' : 'Buat subtitle'}
                            </button>
                            {clip.subtitledUrl ? (
                              <button type="button" onClick={() => patchClip(idx, { subtitleStatus: 'done' })} className={`w-full ${secondaryButton} py-2.5`}>
                                Batal
                              </button>
                            ) : (
                              <a href={clip.url} download={clip.filename} className={`w-full ${secondaryButton} py-2.5`}>
                                <Download size={14} /> Unduh tanpa subtitle
                              </a>
                            )}
                          </div>
                        )}

                        {clip.subtitleStatus === 'processing' && (
                          <div className="space-y-2 pt-1" role="status">
                            <div className="flex items-center justify-between gap-2 text-[11px] font-black uppercase tracking-wider text-indigo-300 py-1">
                              <span className="flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Menambahkan subtitle</span>
                              <span className="tabular-nums">{clip.subProgress}%</span>
                            </div>
                            <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                              <div className="h-full bg-indigo-500 transition-[width] duration-300 rounded-full" style={{ width: `${clip.subProgress}%` }} />
                            </div>
                          </div>
                        )}

                        {clip.subtitleStatus === 'done' && (
                          <div className="space-y-2 pt-1">
                            <a
                              href={clip.subtitledUrl}
                              download={clip.subtitledFilename}
                              className="w-full flex items-center justify-center gap-2 text-[11px] font-black uppercase tracking-wider bg-green-600 hover:bg-green-500 text-white py-2.5 rounded-xl transition-colors"
                            >
                              <Download size={14} /> Simpan video
                            </a>
                            <div className="grid grid-cols-2 gap-2">
                              <a href={clip.url} download={clip.filename} className={`${secondaryButton} py-2.5 px-2`}>
                                Tanpa subtitle
                              </a>
                              <button type="button" onClick={() => patchClip(idx, { subtitleStatus: 'idle' })} className={`${secondaryButton} py-2.5 px-2`}>
                                <RotateCcw size={13} /> Atur ulang
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </article>
                  ))}
                </div>

                <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <button type="button" onClick={() => setStatus('review')} disabled={!drafts.length} className={secondaryButton}>
                    Kembali ke daftar highlight
                  </button>
                  <button type="button" onClick={resetAll} className={secondaryButton}>
                    Video baru
                  </button>
                </div>
              </Card>
            )}

            <Library
              sessions={sessions}
              activeId={session?.id}
              busy={busy}
              fmt={fmt}
              onOpen={openSession}
              onDelete={deleteSessionItem}
            />
          </div>
        )}
      </div>

      <footer className="max-w-5xl mx-auto mt-8 pb-10 px-4 border-t border-slate-900 pt-6 text-center text-[11px] text-slate-500">
        Open Clipper Pro · video diproses oleh FFmpeg di komputer ini
      </footer>
    </div>
  );
}
