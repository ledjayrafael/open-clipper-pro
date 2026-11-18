import React from 'react';
import { History, FolderOpen, Trash2 } from 'lucide-react';
import { Card } from './ui';

const formatDate = (ms) => new Date(ms).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });

// Earlier sessions: reopen to review or re-render without uploading again.
export default function Library({ sessions, activeId, busy, fmt, onOpen, onDelete }) {
  if (!sessions.length) return null;
  return (
    <Card>
      <div className="flex items-center gap-3 mb-5">
        <History size={18} className="text-slate-500" />
        <h2 className="text-sm font-black uppercase tracking-widest">Riwayat</h2>
      </div>
      <ul className="divide-y divide-slate-800/70">
        {sessions.map(s => (
          <li key={s.id} className="flex items-center gap-3 py-3">
            <div className="flex-1 min-w-0">
              <p className={`text-xs font-bold truncate ${s.id === activeId ? 'text-indigo-300' : 'text-slate-200'}`}>{s.name}</p>
              <p className="text-[11px] text-slate-500 mt-0.5 tabular-nums">
                {formatDate(s.createdAt)} · {fmt(s.duration)} · {s.candidates} highlight · {s.clips} clip
                {s.source === 'duration' && <span className="text-amber-300"> · tanpa transkrip</span>}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onOpen(s.id)}
              disabled={busy || s.id === activeId}
              className="shrink-0 flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wider px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 hover:border-slate-600 text-slate-300 disabled:opacity-40"
            >
              <FolderOpen size={12} /> {s.id === activeId ? 'Terbuka' : 'Buka'}
            </button>
            <button
              type="button"
              onClick={() => onDelete(s)}
              disabled={busy}
              aria-label={`Hapus ${s.name}`}
              title="Hapus"
              className="shrink-0 p-2 text-slate-500 hover:text-red-400 disabled:opacity-40"
            >
              <Trash2 size={16} />
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
