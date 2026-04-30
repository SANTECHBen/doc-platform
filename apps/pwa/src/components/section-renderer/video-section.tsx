'use client';

// Video section renderer. Renders the source video, seeks to timeStart on
// load, and clamps playback to the [start, end] window — pause + seek-back
// when the user scrubs outside, auto-pause when end is reached.

import { useEffect, useRef } from 'react';
import type { DocumentBody, PwaDocumentSection } from '@/lib/api';

export function VideoSection({
  doc,
  section,
}: {
  doc: DocumentBody;
  section: PwaDocumentSection;
}): React.ReactElement {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const start = section.timeStartSeconds ?? 0;
  const end = section.timeEndSeconds ?? Infinity;

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    function onLoaded() {
      if (!v) return;
      v.currentTime = start;
    }

    function onTimeUpdate() {
      if (!v) return;
      if (v.currentTime >= end) {
        v.pause();
        v.currentTime = end;
        return;
      }
      if (v.currentTime < start) {
        v.currentTime = start;
      }
    }

    v.addEventListener('loadedmetadata', onLoaded);
    v.addEventListener('timeupdate', onTimeUpdate);
    return () => {
      v.removeEventListener('loadedmetadata', onLoaded);
      v.removeEventListener('timeupdate', onTimeUpdate);
    };
  }, [start, end]);

  if (doc.kind === 'external_video' && doc.externalUrl) {
    // External videos don't expose currentTime control across origins, so we
    // use a YouTube/Vimeo embed URL with start/end params where supported.
    const embed = toEmbedWithRange(doc.externalUrl, start, end);
    return (
      <iframe
        src={embed}
        title={section.title}
        className="aspect-video w-full border-0 bg-black"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowFullScreen
      />
    );
  }

  if (!doc.fileUrl) {
    return (
      <p className="px-4 text-xs text-ink-tertiary">Video file URL is not available.</p>
    );
  }

  return (
    <video
      ref={videoRef}
      src={doc.fileUrl}
      controls
      preload="metadata"
      className="aspect-video w-full bg-black"
    />
  );
}

function toEmbedWithRange(raw: string, start: number, end: number): string {
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\./, '');
    const startParam = `start=${Math.floor(start)}`;
    const endParam = Number.isFinite(end) ? `&end=${Math.floor(end)}` : '';
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      const id = url.searchParams.get('v');
      if (id) return `https://www.youtube.com/embed/${id}?${startParam}${endParam}&autoplay=1`;
    }
    if (host === 'youtu.be') {
      const id = url.pathname.replace(/^\//, '');
      if (id) return `https://www.youtube.com/embed/${id}?${startParam}${endParam}&autoplay=1`;
    }
    if (host === 'vimeo.com') {
      const id = url.pathname.replace(/^\//, '').split('/')[0];
      if (id) return `https://player.vimeo.com/video/${id}#t=${Math.floor(start)}s`;
    }
    return raw;
  } catch {
    return raw;
  }
}
