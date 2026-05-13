// Hero-video URL classification — used by procedure intro videos when an
// author pastes an external link instead of uploading a file. The PWA
// renderer picks an <iframe> for YouTube/Vimeo and a native <video> tag
// for direct mp4/webm/mov URLs.
//
// Kept dependency-free so it can run in the API (validation), the admin
// app, and the PWA.

export type VideoEmbed =
  | { kind: 'youtube'; embedUrl: string; videoId: string }
  | { kind: 'vimeo'; embedUrl: string; videoId: string }
  | { kind: 'native'; src: string };

/** Recognize a pasted intro-video URL. Returns null if the URL is not a
 *  syntactically valid http(s) URL. */
export function parseVideoEmbed(url: string): VideoEmbed | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  const host = parsed.hostname.replace(/^www\./, '').toLowerCase();

  // YouTube — youtube.com/watch?v=, youtube.com/embed/, youtu.be/.
  if (host === 'youtube.com' || host === 'm.youtube.com') {
    const v = parsed.searchParams.get('v');
    if (v && /^[\w-]{6,}$/.test(v)) {
      return { kind: 'youtube', videoId: v, embedUrl: `https://www.youtube.com/embed/${v}` };
    }
    const embedId = parsed.pathname.match(/^\/embed\/([\w-]{6,})/)?.[1];
    if (embedId) {
      return {
        kind: 'youtube',
        videoId: embedId,
        embedUrl: `https://www.youtube.com/embed/${embedId}`,
      };
    }
    const shortsId = parsed.pathname.match(/^\/shorts\/([\w-]{6,})/)?.[1];
    if (shortsId) {
      return {
        kind: 'youtube',
        videoId: shortsId,
        embedUrl: `https://www.youtube.com/embed/${shortsId}`,
      };
    }
  }
  if (host === 'youtu.be') {
    const id = parsed.pathname.slice(1).split('/')[0];
    if (id && /^[\w-]{6,}$/.test(id)) {
      return { kind: 'youtube', videoId: id, embedUrl: `https://www.youtube.com/embed/${id}` };
    }
  }

  // Vimeo — vimeo.com/{id} or player.vimeo.com/video/{id}.
  if (host === 'vimeo.com') {
    const id = parsed.pathname.match(/^\/(\d{4,})/)?.[1];
    if (id) {
      return { kind: 'vimeo', videoId: id, embedUrl: `https://player.vimeo.com/video/${id}` };
    }
  }
  if (host === 'player.vimeo.com') {
    const id = parsed.pathname.match(/^\/video\/(\d{4,})/)?.[1];
    if (id) {
      return { kind: 'vimeo', videoId: id, embedUrl: `https://player.vimeo.com/video/${id}` };
    }
  }

  // Anything else: assume the URL points directly at a video file.
  // Browser <video> tags will handle mp4/webm/mov; a 404/format mismatch
  // surfaces through the existing onError fallback in StepVideoPlayer.
  return { kind: 'native', src: url };
}
