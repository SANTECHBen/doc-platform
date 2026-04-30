'use client';

// SectionHighlight — paints translucent overlay rects on top of a PdfPage to
// show the user where a section's anchor text falls. Stateless; the parent
// computes rects with `rectsForSpan(...)` from the excerpt locator.

import type { CSSProperties } from 'react';

export interface HighlightRectInput {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SectionHighlightProps {
  rects: ReadonlyArray<HighlightRectInput>;
  /** Background color (with alpha) used for the highlight fill.
   *  Default: yellow/0.35. */
  color?: string;
  /** Border color. Default: rgba(202, 138, 4, 0.7) (amber-600). */
  borderColor?: string;
  /** Pointer-events behavior. Default: 'none' (clicks pass through to page). */
  pointerEvents?: 'auto' | 'none';
  className?: string;
}

const DEFAULT_FILL = 'rgba(250, 204, 21, 0.35)'; // tailwind yellow-400 @ 0.35
const DEFAULT_BORDER = 'rgba(202, 138, 4, 0.7)'; // amber-600 @ 0.7

export function SectionHighlight(props: SectionHighlightProps): React.ReactElement {
  const {
    rects,
    color = DEFAULT_FILL,
    borderColor = DEFAULT_BORDER,
    pointerEvents = 'none',
    className,
  } = props;

  const baseStyle: CSSProperties = {
    position: 'absolute',
    inset: 0,
    pointerEvents,
  };

  return (
    <div className={`section-highlight ${className ?? ''}`} style={baseStyle} aria-hidden>
      {rects.map((r, idx) => (
        <div
          key={idx}
          style={{
            position: 'absolute',
            left: `${r.x}px`,
            top: `${r.y}px`,
            width: `${r.width}px`,
            height: `${r.height}px`,
            background: color,
            border: `1px solid ${borderColor}`,
            borderRadius: '2px',
            boxSizing: 'border-box',
            mixBlendMode: 'multiply',
          }}
        />
      ))}
    </div>
  );
}
