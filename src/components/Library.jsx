import React from 'react';
import { History, FolderOpen, Trash2 } from 'lucide-react';

const formatDate = (ms) => new Date(ms).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });

// Earlier sessions: reopen to review or re-render without uploading again.
export default function Library({ sessions, activeId, busy, fmt, onOpen, onDelete }) {
  if (!sessions.length) return null;
  return (
    <div className="bg-[#0A0A0A] border border-slate-800/60 rounded-3xl p-8">
      <div className="flex items-center gap-3 mb-5">
        <History size={18} className="text-slate-500" />
        <h2 className="text-sm font-black uppercase tracking-widest">Riwayat</h2>
      </div>
      <ul className="divide-y divide-slate-800/70">
        {sessions.map(s => (
          <li key={s.id} className="flex items-center gap-3 py-3">
            <div className="flex-1 min-w-0">
              <p className={`text-xs font-bold truncate ${s.id === activeId ? 'text-indigo-300' : 'text-slate-200'}`}>{s.name}</p>
              <p className="text-[10px] text-slate-500 mt-0.5">
                {formatDate(s.createdAt)} · {fmt(s.duration)} · {s.candidates} highlight · {s.clips} clip
                {s.source === 'duration' && ' · tanpa transkrip'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onOpen(s.id)}
              disabled={busy || s.id === activeId}
              className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 hover:border-slate-600 text-slate-300 disabled:opacity-40"
            >
              <FolderOpen size={12} /> {s.id === activeId ? 'Terbuka' : 'Buka'}
            </button>
            <button
              type="button"
              onClick={() => onDelete(s)}
              disabled={busy}
              aria-label={`Hapus ${s.name}`}
              className="p-2 text-slate-600 hover:text-red-500 disabled:opacity-40"
            >
              <Trash2 size={16} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
