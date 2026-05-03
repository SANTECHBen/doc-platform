'use client';

import { Maximize, Minimize } from 'lucide-react';
import { useEffect, useState } from 'react';

type Density = 'compact' | 'comfortable';

// Bumps the html font-size when set to 'comfortable' so every rem-based
// dimension (Tailwind defaults, gap, padding, font sizes) scales up. Made
// for techs in PPE / gloves who need bigger tap targets and text.
export function DensityToggle({ className }: { className?: string }) {
  const [density, setDensity] = useState<Density>('compact');

  useEffect(() => {
    const stored = (localStorage.getItem('density') as Density | null) ?? 'compact';
    setDensity(stored);
  }, []);

  function toggle() {
    const next: Density = density === 'compact' ? 'comfortable' : 'compact';
    setDensity(next);
    localStorage.setItem('density', next);
    if (next === 'comfortable') {
      document.documentElement.setAttribute('data-density', 'comfortable');
    } else {
      document.documentElement.removeAttribute('data-density');
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      className={`inline-flex h-10 w-10 items-center justify-center rounded-md text-ink-secondary transition hover:bg-surface-inset hover:text-ink-primary ${className ?? ''}`}
      aria-label={`Switch to ${density === 'compact' ? 'comfortable' : 'compact'} density`}
      title={`Switch to ${density === 'compact' ? 'comfortable' : 'compact'} density`}
    >
      {density === 'compact' ? (
        <Maximize size={18} strokeWidth={1.75} />
      ) : (
        <Minimize size={18} strokeWidth={1.75} />
      )}
    </button>
  );
}

// Compact is the default — only set data-density='comfortable' when user opts in.
// Mirrors the theme boot script pattern; prevents flash of wrong density on
// first paint.
export const densityBootScript = `
(function(){
  try {
    var d = localStorage.getItem('density');
    if (d === 'comfortable') document.documentElement.setAttribute('data-density','comfortable');
  } catch (e) {}
})();
`;
