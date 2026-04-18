'use client';

import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

// `sidebar` variant — white-on-graphite, meant for the dark sidebar footer.
// `topbar` variant — adapts to surrounding surface tokens, shows label.
export function ThemeToggle({
  className,
  variant = 'sidebar',
}: {
  className?: string;
  variant?: 'sidebar' | 'topbar';
}) {
  const [theme, setTheme] = useState<Theme>('light');

  useEffect(() => {
    const stored = (localStorage.getItem('theme') as Theme | null) ?? 'light';
    setTheme(stored);
  }, []);

  function toggle() {
    const next: Theme = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    localStorage.setItem('theme', next);
    if (next === 'light') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', 'dark');
  }

  const labelNext = theme === 'light' ? 'dark' : 'light';
  const Icon = theme === 'light' ? Moon : Sun;

  if (variant === 'topbar') {
    return (
      <button
        type="button"
        onClick={toggle}
        className={`inline-flex h-8 items-center gap-2 rounded border border-line bg-surface-raised px-3 text-sm text-ink-secondary transition hover:border-line-strong hover:text-ink-primary ${className ?? ''}`}
        aria-label={`Switch to ${labelNext} theme`}
        title={`Switch to ${labelNext} theme`}
      >
        <Icon size={14} strokeWidth={1.75} />
        <span className="hidden md:inline">{theme === 'light' ? 'Dark' : 'Light'}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={toggle}
      className={`inline-flex h-7 w-7 items-center justify-center rounded text-white/65 transition hover:bg-white/10 hover:text-white ${className ?? ''}`}
      aria-label={`Switch to ${labelNext} theme`}
      title={`Switch to ${labelNext} theme`}
    >
      <Icon size={14} strokeWidth={2} />
    </button>
  );
}

export const themeBootScript = `
(function(){
  try {
    var t = localStorage.getItem('theme');
    if (t === 'dark') document.documentElement.setAttribute('data-theme','dark');
  } catch (e) {}
})();
`;
