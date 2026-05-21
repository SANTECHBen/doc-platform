'use client';

// HeroVideoEmbed — chooses between a native <video> tag and a provider
// iframe (YouTube/Vimeo) for the procedure-level intro video. The PWA
// renders it in two places: the scroll-view top, and the Job Aid "Step
// 0" landing panel.
//
// Native files (uploaded mp4/webm or direct external mp4 URLs) flow
// through StepVideoPlayer so they get the same chrome (large play
// overlay, fullscreen button, auto-pause on playId change) as per-step
// videos. Embeds render in an <iframe> matched to the same 16:9 frame
// so the visual rhythm stays consistent.

import { parseVideoEmbed } from '@platform/shared';
import { StepVideoPlayer } from './step-video-player';

interface Props {
  url: string;
  alt?: string;
  caption?: string | null;
  muted?: boolean;
  playId: string;
  className?: string;
}

export function HeroVideoEmbed({
  url,
  alt,
  caption,
  muted = false,
  playId,
  className,
}: Props): React.ReactElement {
  const embed = parseVideoEmbed(url);

  if (embed?.kind === 'youtube' || embed?.kind === 'vimeo') {
    return (
      <figure className={`step-video-frame ${className ?? ''}`}>
        <iframe
          src={embed.embedUrl}
          title={alt ?? caption ?? 'Intro video'}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
          style={{ width: '100%', height: '100%', border: 0 }}
        />
        {caption && (
          <figcaption className="step-video-caption">{caption}</figcaption>
        )}
      </figure>
    );
  }

  // Hero video gets tap-to-play behavior (autoplay={false}) — the
  // procedure-level intro is something the author wants the tech to
  // engage with on purpose, not background motion. Per-step clips
  // inside virtual-job-aid still autoplay (their default).
  return (
    <StepVideoPlayer
      src={url}
      alt={alt}
      caption={caption}
      muted={muted}
      autoplay={false}
      playId={playId}
      className={className}
    />
  );
}
