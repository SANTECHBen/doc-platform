'use client';

import { Command, Search } from 'lucide-react';
import { useEffect, useState } from 'react';

export function TopBar({ children }: { children?: React.ReactNode }) {
  const [isMac, setIsMac] = useState(false);

  useEffect(() => {
    setIsMac(/Mac|iPod|iPhone|iPad/.test(navigator.platform));
  }, []);

  function triggerPalette() {
    const isMacRuntime = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
    const ev = new KeyboardEvent('keydown', {
      key: 'k',
      metaKey: isMacRuntime,
      ctrlKey: !isMacRuntime,
      bubbles: true,
    });
    window.dispatchEvent(ev);
  }

  return (
    <header
      className="sticky top-0 z-30 flex items-center justify-between border-b border-line px-6 py-3.5 backdrop-blur-md lg:px-10"
      style={{ background: 'rgb(var(--surface-base) / 0.85)' }}
    >
      <div className="flex min-h-[32px] flex-1 items-center">{children}</div>
      <button onClick={triggerPalette} className="quickfind-btn">
        <Search size={14} strokeWidth={2} />
        <span className="hidden md:inline">Quick find</span>
        <span className="kbd-row">
          <span className="kbd">
            {isMac ? <Command size={10} strokeWidth={2.5} /> : 'Ctrl'}
          </span>
          <span className="kbd">K</span>
        </span>
      </button>
      <style jsx>{`
        .quickfind-btn {
          display: inline-flex;
          align-items: center;
          gap: 10px;
          padding: 0 10px 0 12px;
          height: 32px;
          background: rgb(var(--surface-raised));
          border: 1px solid rgb(var(--line));
          border-radius: 4px;
          color: rgb(var(--ink-tertiary));
          font-family: inherit;
          font-size: 12.5px;
          cursor: pointer;
          transition: all 140ms ease;
        }
        .quickfind-btn:hover {
          border-color: rgb(var(--line-strong));
          color: rgb(var(--ink-secondary));
        }
        .kbd-row {
          display: inline-flex;
          gap: 2px;
          align-items: center;
        }
      `}</style>
    </header>
  );
}
