'use client';

// Shared Job Aid block renderer — the SINGLE SOURCE for rendering a step's
// typed content blocks. Used by the PWA runner (virtual-job-aid) and the admin
// device-preview so the two can never drift. Markup + classes copied from the
// original PWA BlockRenderer; styling lives in ./job-aid.css.

import * as React from 'react';
import { useState } from 'react';
import { AlertTriangle, Info, Lightbulb, ShieldAlert } from 'lucide-react';
import type { JobAidBlock, JobAidMedia } from './types.js';

export function JobAidBlockRenderer({
  block,
  media,
}: {
  block: JobAidBlock;
  media: JobAidMedia[];
}): React.ReactElement | null {
  switch (block.kind) {
    case 'paragraph':
      return <p className="vja-block-paragraph">{linkifyText(block.text)}</p>;

    case 'callout': {
      const tone = block.tone;
      const Icon =
        tone === 'safety'
          ? ShieldAlert
          : tone === 'warning'
            ? AlertTriangle
            : tone === 'tip'
              ? Lightbulb
              : Info;
      return (
        <aside className={`vja-block-callout vja-callout-${tone}`}>
          <span className="vja-callout-icon" aria-hidden>
            <Icon size={18} strokeWidth={2} />
          </span>
          <div className="vja-callout-body">
            {block.title && <p className="vja-callout-title">{block.title}</p>}
            <p className="vja-callout-text">{linkifyText(block.text)}</p>
          </div>
        </aside>
      );
    }

    case 'bullet_list':
      return (
        <ul className="vja-block-list">
          {block.items.map((it, i) => (
            <li key={i}>{linkifyText(it)}</li>
          ))}
        </ul>
      );

    case 'numbered_list':
      return (
        <ol className="vja-block-list vja-block-list-numbered">
          {block.items.map((it, i) => (
            <li key={i}>{linkifyText(it)}</li>
          ))}
        </ol>
      );

    case 'key_value':
      return (
        <table className="vja-block-kv">
          <thead>
            <tr>
              <th>{block.columns[0]}</th>
              <th>{block.columns[1]}</th>
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, i) => (
              <tr key={i}>
                <td>{row[0]}</td>
                <td>{row[1]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );

    case 'photo_inline': {
      const m = media.find((mm) => mm.storageKey === block.storageKey);
      if (!m || m.kind !== 'image' || !m.url) return null;
      const caption = block.caption ?? m.caption ?? null;
      return (
        <figure className="vja-block-photo">
          <JobAidFallbackImage
            src={m.url}
            alt={caption ?? 'Step photo'}
            label={caption ?? 'Photo unavailable'}
          />
          {caption && <figcaption>{caption}</figcaption>}
        </figure>
      );
    }
  }
}

/** Image with a graceful fallback when load fails. */
export function JobAidFallbackImage({
  src,
  alt,
  label,
}: {
  src: string;
  alt: string;
  label: string;
}): React.ReactElement {
  const [failed, setFailed] = useState(false);
  if (failed || !src) {
    return (
      <div className="vja-media-fallback" role="img" aria-label={alt}>
        <span aria-hidden>📷</span>
        <span>{label}</span>
      </div>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />;
}

// Lightweight linkify — detects http(s):// URLs in text and wraps them in <a>.
// Avoids a markdown parser for plain prose; the authoring surface only allows
// bare URLs anyway. (Verbatim from the original PWA runner.)
export function linkifyText(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const re = /(https?:\/\/[^\s)]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <a key={m.index} href={m[1]} target="_blank" rel="noopener noreferrer">
        {m[1]}
      </a>,
    );
    last = m.index + m[1]!.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length > 0 ? parts : text;
}
