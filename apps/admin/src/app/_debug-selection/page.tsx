'use client';

// Debug page: diagnose why text selection is broken on this admin app.
// Visit /_debug-selection to run live tests. Logs results visibly on the
// page so no console paste is required.

import { useEffect, useState, useRef } from 'react';

interface MouseEventLog {
  type: string;
  target: string;
  cls: string;
  prevented: boolean;
  ts: number;
}

export default function DebugSelection() {
  const [overlays, setOverlays] = useState<unknown[]>([]);
  const [events, setEvents] = useState<MouseEventLog[]>([]);
  const [selection, setSelection] = useState<string>('');
  const [computedBody, setComputedBody] = useState<Record<string, string>>({});
  const eventsRef = useRef<MouseEventLog[]>([]);

  useEffect(() => {
    // Snapshot computed style of <body> for user-select etc.
    const cs = getComputedStyle(document.body);
    setComputedBody({
      'user-select': cs.userSelect,
      '-webkit-user-select': cs.webkitUserSelect ?? 'n/a',
      'pointer-events': cs.pointerEvents,
      'cursor': cs.cursor,
    });

    // Find any large fixed/absolute element that might be invisibly covering the page.
    const found = [...document.querySelectorAll('*')]
      .filter((el) => {
        const c = getComputedStyle(el);
        if (c.position !== 'fixed' && c.position !== 'absolute') return false;
        const r = el.getBoundingClientRect();
        return r.width > window.innerWidth * 0.5 && r.height > window.innerHeight * 0.5;
      })
      .map((el) => {
        const c = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          cls: String(el.className).slice(0, 80),
          z: c.zIndex,
          pe: c.pointerEvents,
          us: c.userSelect,
          vis: c.visibility,
          op: c.opacity,
          rect: `${Math.round(r.width)}×${Math.round(r.height)}`,
        };
      });
    setOverlays(found);

    // Capture-phase listeners — runs before any other handler.
    function logEvent(e: Event) {
      const t = e.target as HTMLElement;
      const log: MouseEventLog = {
        type: e.type,
        target: t.tagName ?? '?',
        cls: String(t.className ?? '').slice(0, 60),
        prevented: e.defaultPrevented,
        ts: Date.now(),
      };
      eventsRef.current = [log, ...eventsRef.current.slice(0, 19)];
      setEvents([...eventsRef.current]);
    }
    document.addEventListener('mousedown', logEvent, true);
    document.addEventListener('selectstart', logEvent, true);
    document.addEventListener('mouseup', logEvent, true);

    function onSel() {
      setSelection(window.getSelection()?.toString() ?? '');
    }
    document.addEventListener('selectionchange', onSel);

    return () => {
      document.removeEventListener('mousedown', logEvent, true);
      document.removeEventListener('selectstart', logEvent, true);
      document.removeEventListener('mouseup', logEvent, true);
      document.removeEventListener('selectionchange', onSel);
    };
  }, []);

  return (
    <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif', maxWidth: 1100 }}>
      <h1 style={{ fontSize: 24, marginBottom: 16 }}>Selection Debug</h1>

      <section style={{ marginBottom: 24, padding: 16, border: '2px dashed #888' }}>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>1. Try to select this paragraph</h2>
        <p
          id="test-paragraph"
          style={{ fontSize: 16, lineHeight: 1.6, padding: 12, background: '#f5f5f5' }}
        >
          The quick brown fox jumps over the lazy dog. Try mouse-dragging across this
          text to highlight it. If selection works, you should see the highlighted text
          appear in the box below as you drag. If nothing appears, the drag is being
          intercepted before reaching the browser&apos;s selection logic.
        </p>
      </section>

      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>
          2. Live selection ({selection.length} chars)
        </h2>
        <div
          style={{
            padding: 12,
            border: '1px solid #ccc',
            background: '#fafafa',
            minHeight: 40,
            fontFamily: 'monospace',
            fontSize: 13,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {selection || <em style={{ color: '#999' }}>nothing selected</em>}
        </div>
      </section>

      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>3. Computed style of &lt;body&gt;</h2>
        <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
          <tbody>
            {Object.entries(computedBody).map(([k, v]) => (
              <tr key={k}>
                <td style={{ padding: '4px 12px', border: '1px solid #ddd' }}>{k}</td>
                <td
                  style={{
                    padding: '4px 12px',
                    border: '1px solid #ddd',
                    fontFamily: 'monospace',
                    color: v === 'none' ? '#c00' : '#080',
                  }}
                >
                  {v}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>
          4. Large fixed/absolute elements ({overlays.length})
        </h2>
        {overlays.length === 0 ? (
          <p style={{ color: '#080' }}>None — no invisible page-covering overlays.</p>
        ) : (
          <pre style={{ background: '#f5f5f5', padding: 12, fontSize: 12, overflow: 'auto' }}>
            {JSON.stringify(overlays, null, 2)}
          </pre>
        )}
      </section>

      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>
          5. Mouse events log ({events.length})
        </h2>
        <p style={{ fontSize: 13, color: '#666', marginBottom: 8 }}>
          Try dragging across the test paragraph above. You should see at least
          mousedown → selectstart → mouseup events. If selectstart is missing OR
          prevented:true appears, something is blocking it.
        </p>
        <div
          style={{
            background: '#0a0a0a',
            color: '#0f0',
            padding: 12,
            fontFamily: 'monospace',
            fontSize: 12,
            maxHeight: 300,
            overflow: 'auto',
          }}
        >
          {events.length === 0 ? (
            <em style={{ color: '#666' }}>(no events yet — try dragging on the paragraph)</em>
          ) : (
            events.map((e, i) => (
              <div key={i}>
                {new Date(e.ts).toISOString().slice(11, 23)} {e.type.padEnd(13)} target=
                {e.target}.{e.cls}
                {e.prevented ? ' ⛔ PREVENTED' : ''}
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
