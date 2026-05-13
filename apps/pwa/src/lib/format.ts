// Tiny format helpers shared by the procedure intro renderings (Job Aid
// "Step 0" panel and the scroll-view top). Pure functions, no deps.

/** "45 min" / "1 h 30 min" / "2 h" — human-friendly duration for techs
 *  scanning a procedure before they start. Negative input is clamped. */
export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m - h * 60;
  return rem === 0 ? `${h} h` : `${h} h ${rem} min`;
}

export function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
