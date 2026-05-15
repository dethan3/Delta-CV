/** Escape HTML special characters. */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Format ISO period strings to "yyyy-MM – yyyy-MM". */
export function formatPeriod(from: string, to: string): string {
  const f = from.slice(0, 7);
  const t = to.slice(0, 7);
  return f === t ? f : `${f} – ${t}`;
}
