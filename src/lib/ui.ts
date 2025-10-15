export const CHECKPOINT_STATUS_LABEL = {
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  error: 'Error',
} as const;

export const CHECKPOINT_STATUS_STYLE = {
  queued: 'border border-zinc-700 bg-zinc-900/80 text-zinc-200',
  running: 'bg-emerald-400 text-emerald-950 shadow-[0_0_0_1px_rgba(16,185,129,0.35)]',
  completed: 'bg-emerald-200 text-emerald-900',
  error: 'border border-red-400/40 bg-red-500/20 text-red-100',
} as const;

export {};
