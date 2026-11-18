// Option lists shared by several components.

// Clip length presets in seconds; the backend enforces them on the AI's picks.
export const LENGTH_PRESETS = [
  { id: 'short', label: '15–30 dtk', min: 15, max: 30 },
  { id: 'medium', label: '30–60 dtk', min: 30, max: 60 },
  { id: 'long', label: '60–90 dtk', min: 60, max: 90 },
];

// The preset that matches a session's stored min/max, if any.
export const presetFor = (minDur, maxDur) =>
  LENGTH_PRESETS.find(p => p.min === minDur && p.max === maxDur)?.id;

// How a landscape source becomes 9:16.
export const REFRAME_OPTIONS = [
  { id: 'track', label: 'Ikuti wajah', hint: 'Crop bergerak mengikuti wajah utama' },
  { id: 'center', label: 'Crop tengah', hint: 'Potong bagian tengah, paling cepat' },
  { id: 'blur', label: 'Utuh + blur', hint: 'Seluruh frame, latar diisi versi blur' },
  { id: 'black', label: 'Utuh + hitam', hint: 'Seluruh frame dengan bar hitam' },
];

export const scoreClass = (score) =>
  score >= 80 ? 'bg-green-500/20 text-green-400' :
  score >= 50 ? 'bg-yellow-500/20 text-yellow-400' :
  'bg-red-500/20 text-red-400';
