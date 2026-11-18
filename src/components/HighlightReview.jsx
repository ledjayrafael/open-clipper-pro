import React from 'react';
import { Play, TrendingUp, Scissors, RefreshCw, Loader2, Target } from 'lucide-react';
import AnalysisOptions from './AnalysisOptions';
import { REFRAME_OPTIONS, scoreClass } from '../lib/options';
import { Card, StepHeader, FieldLabel, Segmented, ProgressPanel, primaryButton, secondaryButton } from './ui';

const MIN_CLIP_SECONDS = 1;
const MAX_CLIP_SECONDS = 300;

const draftIsValid = (draft, duration) =>
  Number.isFinite(draft.start) && Number.isFinite(draft.end) &&
  draft.start >= 0 && draft.end <= duration + 0.5 &&
  draft.end - draft.start >= MIN_CLIP_SECONDS && draft.end - draft.start <= MAX_CLIP_SECONDS;

const inputClass = 'w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-200 focus:outline-none focus:border-indigo-500 disabled:opacity-50';

// What the backend's validator did to the AI's raw picks, in plain words.
const statsSummary = (stats) => {
  if (!stats) return '';
  const parts = [
    stats.extended && `${stats.extended} diperpanjang`,
    stats.trimmed && `${stats.trimmed} dipotong`,
    (stats.tooShort + stats.overlap + stats.invalid) && `${stats.tooShort + stats.overlap + stats.invalid} dibuang`,
  ].filter(Boolean);
  return parts.length ? ` Dari ${stats.received} usulan mentah: ${parts.join(', ')}.` : '';
};

// Step 4: the AI's candidates, editable before anything is rendered.
export default function HighlightReview({
  drafts, setDrafts, duration, analysis, fmt, busy, status, progress,
  onPreview, onRender, onReanalyze,
  hookEnabled, setHookEnabled, reframeMode, setReframeMode,
  analysisOptions, aiLabel,
}) {
  const update = (id, patch) => setDrafts(prev => prev.map(d => (d.id === id ? { ...d, ...patch } : d)));
  const selected = drafts.filter(d => d.selected);
  const invalid = selected.filter(d => !draftIsValid(d, duration));
  const totalSeconds = selected.reduce((sum, d) => sum + Math.max(0, d.end - d.start), 0);
  const allSelected = drafts.length > 0 && selected.length === drafts.length;

  return (
    <Card>
      <StepHeader
        step={4}
        title="Pilih Highlight"
        aside={drafts.length > 1 && (
          <button
            type="button"
            disabled={busy}
            onClick={() => setDrafts(prev => prev.map(d => ({ ...d, selected: !allSelected })))}
            className="shrink-0 text-[11px] font-black uppercase tracking-wider text-indigo-300 hover:text-indigo-200 disabled:opacity-40"
          >
            {allSelected ? 'Kosongkan' : 'Pilih semua'}
          </button>
        )}
      />
      <p className="text-xs text-slate-400 mb-3">
        Centang yang mau dirender. Judul, hook, dan waktu bisa diubah dulu. <span className="text-slate-200 font-bold">Preview</span> memutar bagian itu di player atas.
      </p>

      {analysis && (
        analysis.source === 'transcript' ? (
          <p className="text-[11px] text-slate-500 mb-5">
            {analysis.provider} membaca transkrip {analysis.words.toLocaleString('id-ID')} kata dan mengusulkan {drafts.length} highlight.
            {statsSummary(analysis.stats)}
          </p>
        ) : (
          <p className="text-[11px] text-amber-200 bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3 mb-5">
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
              className={`rounded-2xl border p-4 transition-colors duration-150 ${d.selected ? 'border-indigo-500/50 bg-indigo-500/[0.04]' : 'border-slate-800 bg-black/40'}`}
            >
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={d.selected}
                  disabled={busy}
                  onChange={e => update(d.id, { selected: e.target.checked })}
                  aria-label={`Pilih highlight ${index + 1}: ${d.title}`}
                  className="mt-1.5 w-4 h-4 accent-indigo-500 shrink-0"
                />
                <div className="flex-1 min-w-0 space-y-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      value={d.title}
                      disabled={busy}
                      onChange={e => update(d.id, { title: e.target.value })}
                      aria-label={`Judul highlight ${index + 1}`}
                      className={`${inputClass} text-sm basis-full sm:basis-0 grow min-w-0`}
                    />
                    {d.requested && (
                      <span className="shrink-0 flex items-center gap-1 text-[10px] font-black px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300" title="Diminta lewat arahan AI">
                        <Target size={10} /> Diminta
                      </span>
                    )}
                    <span className={`shrink-0 flex items-center gap-1 text-[10px] font-black px-2 py-0.5 rounded-full tabular-nums ${scoreClass(d.viralScore)}`} title="Skor viral menurut AI">
                      <TrendingUp size={10} /> {d.viralScore}
                    </span>
                  </div>

                  {d.reason && <p className="text-[11px] text-slate-400 leading-snug">{d.reason}</p>}

                  <div className="grid grid-cols-2 sm:grid-cols-[1fr_1fr_auto] gap-2 items-end">
                    <label className="block">
                      <span className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1">Mulai (dtk)</span>
                      <input
                        type="number" step="0.1" min="0" max={duration}
                        value={d.start}
                        disabled={busy}
                        onChange={e => update(d.id, { start: Number(e.target.value) })}
                        className={`${inputClass} font-mono tabular-nums`}
                      />
                    </label>
                    <label className="block">
                      <span className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1">Selesai (dtk)</span>
                      <input
                        type="number" step="0.1" min="0" max={duration}
                        value={d.end}
                        disabled={busy}
                        onChange={e => update(d.id, { end: Number(e.target.value) })}
                        className={`${inputClass} font-mono tabular-nums`}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => onPreview(d.start, d.end)}
                      disabled={!valid}
                      className="col-span-2 sm:col-span-1 flex items-center justify-center gap-1.5 text-[11px] font-black uppercase tracking-wider px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 hover:border-slate-600 text-slate-300 disabled:opacity-40"
                    >
                      <Play size={12} /> Preview
                    </button>
                  </div>
                  <p className={`text-[11px] font-mono tabular-nums ${valid ? 'text-slate-500' : 'text-red-400'}`}>
                    {valid
                      ? `${fmt(d.start)}–${fmt(d.end)} · ${Math.round(d.end - d.start)} dtk`
                      : `Waktu tidak valid: selesai harus setelah mulai, maksimal ${fmt(duration)}, dan durasi 1 dtk–5 menit.`}
                  </p>

                  {hookEnabled && (
                    <label className="block">
                      <span className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1">Hook text</span>
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

      <div className="mt-6 space-y-4 border-t border-slate-800/70 pt-6">
        <div>
          <FieldLabel>Reframe 9:16</FieldLabel>
          <Segmented
            label="Reframe 9:16"
            options={REFRAME_OPTIONS.map(o => ({ id: o.id, label: o.label, title: o.hint }))}
            value={reframeMode}
            onChange={setReframeMode}
            disabled={busy}
            columns={2}
          />
          <p className="mt-1.5 text-[11px] text-slate-500">{REFRAME_OPTIONS.find(o => o.id === reframeMode)?.hint}</p>
        </div>

        <label className="flex items-center gap-3 text-sm font-black text-slate-300">
          <input type="checkbox" checked={hookEnabled} disabled={busy} onChange={e => setHookEnabled(e.target.checked)} className="w-4 h-4 accent-indigo-500" />
          Hook text di 4 detik pertama
        </label>
      </div>

      <button
        type="button"
        onClick={onRender}
        disabled={busy || selected.length === 0 || invalid.length > 0}
        className={`mt-5 ${primaryButton}`}
      >
        {status === 'rendering'
          ? <><Loader2 className="animate-spin" size={20} /> Merender...</>
          : <><Scissors size={20} /> Render {selected.length} clip</>}
      </button>
      <p className={`mt-2 text-[11px] text-center ${invalid.length ? 'text-red-400' : 'text-slate-500'}`}>
        {invalid.length > 0
          ? `Perbaiki waktu ${invalid.length} highlight yang tidak valid dulu.`
          : selected.length > 0
            ? `Total ${fmt(totalSeconds)} video akan dirender.`
            : 'Pilih minimal satu highlight.'}
      </p>

      {busy && progress && (
        <div className="mt-6"><ProgressPanel progress={progress} /></div>
      )}

      <details className="mt-6 group rounded-2xl border border-slate-800 bg-black/30">
        <summary className="cursor-pointer list-none flex items-center justify-between gap-3 px-4 py-3.5 text-[11px] font-black uppercase tracking-widest text-slate-400 hover:text-slate-200">
          Kurang cocok? Analisis ulang
          <RefreshCw size={14} className="shrink-0 transition-transform duration-200 group-open:rotate-180" />
        </summary>
        <div className="px-4 pb-4 space-y-4">
          <p className="text-[11px] text-slate-500">
            Memakai transkrip yang sudah ada, jadi cepat. Daftar di atas diganti; clip yang sudah dirender tetap ada.
          </p>
          <AnalysisOptions idPrefix="reanalyze" disabled={busy} directionRows={3} {...analysisOptions} />
          <button type="button" onClick={onReanalyze} disabled={busy} className={`w-full ${secondaryButton}`}>
            {status === 'analyzing'
              ? <><Loader2 size={14} className="animate-spin" /> Menganalisis...</>
              : <><RefreshCw size={14} /> Analisis ulang dengan {aiLabel}</>}
          </button>
        </div>
      </details>
    </Card>
  );
}
