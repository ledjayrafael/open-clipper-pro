import React from 'react';
import { Play, TrendingUp, Scissors, RefreshCw, Loader2, Target } from 'lucide-react';

const MIN_CLIP_SECONDS = 1;
const MAX_CLIP_SECONDS = 300;

const draftIsValid = (draft, duration) =>
  Number.isFinite(draft.start) && Number.isFinite(draft.end) &&
  draft.start >= 0 && draft.end <= duration + 0.5 &&
  draft.end - draft.start >= MIN_CLIP_SECONDS && draft.end - draft.start <= MAX_CLIP_SECONDS;

const scoreClass = (score) =>
  score >= 80 ? 'bg-green-500/20 text-green-400' :
  score >= 50 ? 'bg-yellow-500/20 text-yellow-400' :
  'bg-red-500/20 text-red-400';

const inputClass = 'w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-200 focus:outline-none focus:border-indigo-500 disabled:opacity-50';

// Step 3b: the AI's candidates, editable before anything is rendered.
export default function HighlightReview({
  drafts, setDrafts, duration, analysis, fmt, busy, progress,
  onPreview, onRender, onReanalyze,
  hookEnabled, setHookEnabled, faceDetection, setFaceDetection,
  direction, setDirection,
}) {
  const update = (id, patch) => setDrafts(prev => prev.map(d => (d.id === id ? { ...d, ...patch } : d)));
  const selected = drafts.filter(d => d.selected);
  const invalid = selected.filter(d => !draftIsValid(d, duration));

  return (
    <div className="bg-[#0A0A0A] border border-slate-800/60 rounded-3xl p-8">
      <div className="flex items-center gap-3 mb-2">
        <span className="bg-indigo-600 text-white text-[10px] font-black w-6 h-6 flex items-center justify-center rounded-full">3</span>
        <h2 className="text-sm font-black uppercase tracking-widest">Pilih Highlight</h2>
      </div>
      <p className="text-xs text-slate-500 mb-4">
        Centang yang mau dirender. Judul, hook, dan waktu bisa diubah dulu. Klik <span className="text-slate-300 font-bold">Preview</span> untuk memutar bagian itu di atas.
      </p>

      {analysis && (
        analysis.source === 'transcript' ? (
          <p className="text-[11px] text-slate-500 mb-5">
            {analysis.provider} membaca transkrip {analysis.words.toLocaleString('id-ID')} kata dan mengusulkan {drafts.length} highlight.
          </p>
        ) : (
          <p className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3 mb-5">
            {analysis.notice || 'AI hanya melihat durasi video, bukan isinya.'}
          </p>
        )
      )}

      <ul className="space-y-3">
        {drafts.map((d, index) => {
          const valid = draftIsValid(d, duration);
          return (
            <li
              key={d.id}
              className={`rounded-2xl border p-4 transition-colors ${d.selected ? 'border-indigo-500/50 bg-indigo-500/[0.04]' : 'border-slate-800 bg-black/40'}`}
            >
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={d.selected}
                  disabled={busy}
                  onChange={e => update(d.id, { selected: e.target.checked })}
                  aria-label={`Pilih highlight ${index + 1}`}
                  className="mt-1.5 w-4 h-4 accent-indigo-500 shrink-0"
                />
                <div className="flex-1 min-w-0 space-y-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      value={d.title}
                      disabled={busy}
                      onChange={e => update(d.id, { title: e.target.value })}
                      aria-label="Judul"
                      className={`${inputClass} text-sm basis-full sm:basis-0 grow min-w-0`}
                    />
                    {d.requested && (
                      <span className="shrink-0 flex items-center gap-1 text-[10px] font-black px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300" title="Diminta lewat AI direction">
                        <Target size={10} /> Diminta
                      </span>
                    )}
                    <span className={`shrink-0 flex items-center gap-1 text-[10px] font-black px-2 py-0.5 rounded-full ${scoreClass(d.viralScore)}`}>
                      <TrendingUp size={10} /> {d.viralScore}
                    </span>
                  </div>

                  {d.reason && <p className="text-[11px] text-slate-400 leading-snug">{d.reason}</p>}

                  <div className="grid grid-cols-2 sm:grid-cols-[1fr_1fr_auto] gap-2 items-end">
                    <label className="block">
                      <span className="block text-[9px] font-black uppercase tracking-widest text-slate-500 mb-1">Mulai (dtk)</span>
                      <input
                        type="number" step="0.1" min="0" max={duration}
                        value={d.start}
                        disabled={busy}
                        onChange={e => update(d.id, { start: Number(e.target.value) })}
                        className={`${inputClass} font-mono`}
                      />
                    </label>
                    <label className="block">
                      <span className="block text-[9px] font-black uppercase tracking-widest text-slate-500 mb-1">Selesai (dtk)</span>
                      <input
                        type="number" step="0.1" min="0" max={duration}
                        value={d.end}
                        disabled={busy}
                        onChange={e => update(d.id, { end: Number(e.target.value) })}
                        className={`${inputClass} font-mono`}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => onPreview(d.start, d.end)}
                      disabled={!valid}
                      className="col-span-2 sm:col-span-1 flex items-center justify-center gap-1.5 text-[10px] font-black uppercase tracking-wider px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 hover:border-slate-600 text-slate-300 disabled:opacity-40"
                    >
                      <Play size={12} /> Preview
                    </button>
                  </div>
                  <p className={`text-[10px] font-mono ${valid ? 'text-slate-500' : 'text-red-400'}`}>
                    {valid
                      ? `${fmt(d.start)}–${fmt(d.end)} · ${Math.round(d.end - d.start)} dtk`
                      : `Waktu tidak valid: selesai harus setelah mulai, maksimal ${fmt(duration)}, dan durasi 1 dtk–5 menit.`}
                  </p>

                  {hookEnabled && (
                    <label className="block">
                      <span className="block text-[9px] font-black uppercase tracking-widest text-slate-500 mb-1">Hook text</span>
                      <input
                        value={d.hookText}
                        maxLength={80}
                        disabled={busy}
                        placeholder="Kosongkan kalau tanpa hook"
                        onChange={e => update(d.id, { hookText: e.target.value })}
                        className={inputClass}
                      />
                    </label>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="flex items-center gap-3 text-sm font-black text-slate-300">
          <input type="checkbox" checked={hookEnabled} disabled={busy} onChange={e => setHookEnabled(e.target.checked)} className="w-4 h-4 accent-indigo-500" />
          Hook text di 4 detik pertama
        </label>
        <label className="flex items-center gap-3 text-sm font-black text-slate-300">
          <input type="checkbox" checked={faceDetection} disabled={busy} onChange={e => setFaceDetection(e.target.checked)} className="w-4 h-4 accent-indigo-500" />
          Auto Face Detection
        </label>
      </div>

      <button
        type="button"
        onClick={onRender}
        disabled={busy || selected.length === 0 || invalid.length > 0}
        className="mt-5 w-full bg-indigo-600 hover:bg-indigo-500 text-white font-black py-5 rounded-2xl text-sm uppercase tracking-wider shadow-xl active:scale-[0.98] transition-all flex items-center justify-center gap-3 disabled:opacity-30 disabled:cursor-not-allowed"
      >
        {busy ? <><Loader2 className="animate-spin" size={20} /> Memproses...</> : <><Scissors size={20} /> Render {selected.length} clip</>}
      </button>
      {invalid.length > 0 && (
        <p className="mt-2 text-[11px] text-red-400">Perbaiki waktu {invalid.length} highlight yang tidak valid dulu.</p>
      )}

      {busy && progress && (
        <div className="mt-6 p-5 bg-black/60 border border-slate-800 rounded-2xl space-y-3">
          <div className="flex justify-between items-center gap-4">
            <div className="min-w-0">
              <p className="text-[10px] font-black uppercase tracking-widest text-indigo-400 truncate">{progress.step}</p>
              <p className="text-[9px] text-slate-500 mt-0.5">{progress.detail}</p>
            </div>
            <span className="text-xs font-black text-indigo-400">{progress.percent}%</span>
          </div>
          <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
            <div className="h-full bg-indigo-500 transition-all duration-500 rounded-full" style={{ width: `${progress.percent}%` }} />
          </div>
        </div>
      )}

      <details className="mt-6 group">
        <summary className="cursor-pointer text-[10px] font-black uppercase tracking-widest text-slate-500 hover:text-slate-300">
          Kurang cocok? Analisis ulang dengan arahan lain
        </summary>
        <div className="mt-3 space-y-3">
          <textarea
            value={direction}
            onChange={e => setDirection(e.target.value)}
            maxLength={1000}
            rows={3}
            disabled={busy}
            placeholder='Contoh: "fokus ke bagian soal korupsi", "skip intro", atau "ambil 2:00 - 2:50"'
            className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2.5 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 resize-y"
          />
          <button
            type="button"
            onClick={onReanalyze}
            disabled={busy}
            className="w-full flex items-center justify-center gap-2 text-[10px] font-black uppercase tracking-wider py-3 rounded-xl bg-slate-900 border border-slate-800 hover:border-slate-600 text-slate-300 disabled:opacity-40"
          >
            <RefreshCw size={14} /> Analisis ulang (tanpa transkripsi lagi)
          </button>
        </div>
      </details>
    </div>
  );
}
