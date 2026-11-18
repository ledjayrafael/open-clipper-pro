import React from 'react';
import { AlertTriangle, X } from 'lucide-react';

// Shared building blocks so every step card speaks the same visual language.

export const Card = ({ tone = 'default', className = '', children }) => (
  <section
    className={`bg-[#0A0A0A] border rounded-3xl p-6 sm:p-8 ${tone === 'success' ? 'border-green-800/40' : 'border-slate-800/60'} ${className}`}
  >
    {children}
  </section>
);

export const StepHeader = ({ step, title, tone = 'default', aside }) => (
  <div className="flex items-center justify-between gap-3 mb-5">
    <div className="flex items-center gap-3 min-w-0">
      <span
        className={`text-white text-[11px] font-black w-6 h-6 flex items-center justify-center rounded-full shrink-0 ${tone === 'success' ? 'bg-green-600' : 'bg-indigo-600'}`}
        aria-hidden="true"
      >
        {step}
      </span>
      <h2 className={`text-sm font-black uppercase tracking-widest truncate ${tone === 'success' ? 'text-green-400' : ''}`}>{title}</h2>
    </div>
    {aside}
  </div>
);

export const FieldLabel = ({ htmlFor, children }) => {
  const className = 'block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1.5';
  return htmlFor
    ? <label htmlFor={htmlFor} className={className}>{children}</label>
    : <p className={className}>{children}</p>;
};

// Radio buttons drawn as a segmented control.
export const Segmented = ({ label, options, value, onChange, disabled, columns }) => (
  <div
    role="radiogroup"
    aria-label={label}
    className="grid gap-1 p-1 bg-slate-900/60 border border-slate-800 rounded-xl"
    style={{ gridTemplateColumns: `repeat(${columns || options.length}, minmax(0, 1fr))` }}
  >
    {options.map(opt => {
      const active = value === opt.id;
      const off = disabled || opt.disabled;
      return (
        <button
          key={opt.id}
          type="button"
          role="radio"
          aria-checked={active}
          disabled={off}
          title={opt.title}
          onClick={() => onChange(opt.id)}
          className={`min-w-0 py-2 px-2.5 rounded-lg text-left transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed ${active ? 'bg-indigo-600 text-white' : 'text-slate-300 hover:bg-slate-800'}`}
        >
          <span className="block text-xs font-black truncate">{opt.label}</span>
          {opt.hint && (
            <span className={`block truncate text-[10px] font-bold ${active ? 'text-indigo-200' : 'text-slate-500'}`}>{opt.hint}</span>
          )}
        </button>
      );
    })}
  </div>
);

export const ProgressPanel = ({ progress }) => (
  <div className="p-5 bg-black/60 border border-slate-800 rounded-2xl space-y-3" role="status" aria-live="polite">
    <div className="flex justify-between items-start gap-4">
      <div className="min-w-0">
        <p className="text-[11px] font-black uppercase tracking-widest text-indigo-400 truncate">{progress.step}</p>
        {progress.detail && <p className="text-[11px] text-slate-400 mt-0.5">{progress.detail}</p>}
      </div>
      <span className="text-xs font-black text-indigo-400 tabular-nums">{progress.percent}%</span>
    </div>
    <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
      <div className="h-full bg-indigo-500 transition-[width] duration-500 ease-out rounded-full" style={{ width: `${progress.percent}%` }} />
    </div>
  </div>
);

// Inline error instead of alert(): the backend's messages are long and actionable.
export const Notice = ({ title, message, onClose }) => (
  <div role="alert" className="flex items-start gap-3 bg-red-500/10 border border-red-500/25 rounded-2xl p-4 sm:p-5">
    <AlertTriangle size={18} className="text-red-400 shrink-0 mt-0.5" />
    <div className="flex-1 min-w-0">
      <p className="text-xs font-black text-red-300">{title}</p>
      <p className="text-xs text-slate-300 mt-1 leading-relaxed whitespace-pre-line break-words">{message}</p>
    </div>
    <button type="button" onClick={onClose} aria-label="Tutup pesan" className="p-1 -m-1 text-slate-500 hover:text-slate-200 shrink-0">
      <X size={16} />
    </button>
  </div>
);

export const secondaryButton = 'flex items-center justify-center gap-2 text-[11px] font-black uppercase tracking-wider py-3 px-4 rounded-xl bg-slate-900 border border-slate-800 hover:border-slate-600 text-slate-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
export const primaryButton = 'w-full bg-indigo-600 hover:bg-indigo-500 text-white font-black py-5 rounded-2xl text-sm uppercase tracking-wider shadow-lg shadow-black/40 active:scale-[0.98] transition-[background-color,transform] duration-150 flex items-center justify-center gap-3 disabled:opacity-30 disabled:cursor-not-allowed';
export const fieldClass = 'w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm font-bold text-slate-200 focus:outline-none focus:border-indigo-500 disabled:opacity-50';
