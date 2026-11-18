import React from 'react';
import { FieldLabel, Segmented, fieldClass } from './ui';
import { LENGTH_PRESETS } from '../lib/options';

// Count, length and direction: shared by the first analysis and re-analysis.
export default function AnalysisOptions({
  idPrefix, clipCount, setClipCount, clipLength, setClipLength,
  direction, setDirection, disabled, directionRows = 2,
}) {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-4">
        <div>
          <FieldLabel htmlFor={`${idPrefix}-count`}>Jumlah clip</FieldLabel>
          <select
            id={`${idPrefix}-count`}
            value={clipCount}
            onChange={e => setClipCount(Number(e.target.value))}
            disabled={disabled}
            className={`${fieldClass} py-2.5`}
          >
            {Array.from({ length: 10 }, (_, i) => i + 1).map(n => <option key={n} value={n}>{n} clip</option>)}
          </select>
        </div>
        <div>
          <FieldLabel>Durasi per clip</FieldLabel>
          <Segmented
            label="Durasi per clip"
            options={LENGTH_PRESETS}
            value={clipLength}
            onChange={setClipLength}
            disabled={disabled}
          />
        </div>
      </div>

      <div>
        <FieldLabel htmlFor={`${idPrefix}-direction`}>
          Arahan untuk AI <span className="normal-case tracking-normal font-bold text-slate-500">(opsional)</span>
        </FieldLabel>
        <textarea
          id={`${idPrefix}-direction`}
          value={direction}
          onChange={e => setDirection(e.target.value)}
          maxLength={1000}
          rows={directionRows}
          disabled={disabled}
          placeholder='Contoh: "fokus ke bagian soal bisnis", "skip intro", atau "ambil 2:00 - 2:50"'
          className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2.5 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 resize-y disabled:opacity-50"
        />
        <div className="mt-1 flex justify-between gap-3 text-[11px] text-slate-500">
          <span>Rentang waktu yang ditulis (m:ss - m:ss) diambil persis apa adanya.</span>
          <span className="tabular-nums shrink-0">{direction.length}/1000</span>
        </div>
      </div>
    </div>
  );
}
