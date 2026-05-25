'use client';

// QR style domain model + helpers. Sits between the designer UI and the
// `qr-code-styling` engine so that:
//   - the React layer never has to know about the imperative library API,
//   - presets and persisted designs use a stable schema we control,
//   - we can swap out the rendering engine later without churning UI code.
//
// Every QrStyleSpec is fully self-contained: serialize it to JSON, store it,
// re-hydrate later, and the output is reproducible byte-for-byte (given the
// same content string + logo data URI).

import type { Options as EngineOptions } from 'qr-code-styling';

// -----------------------------------------------------------------------------
// Style domain
// -----------------------------------------------------------------------------

export type DotShape = 'square' | 'rounded' | 'dots' | 'classy' | 'classy-rounded' | 'extra-rounded';

export type EyeOuterShape = 'square' | 'extra-rounded' | 'dot';
export type EyeInnerShape = 'square' | 'dot' | 'rounded' | 'extra-rounded';

export type ColorMode = 'solid' | 'linear' | 'radial';

export interface SolidColor {
  mode: 'solid';
  color: string;
}

export interface GradientColor {
  mode: 'linear' | 'radial';
  rotation: number; // degrees, 0 = horizontal left→right
  stops: Array<{ offset: number; color: string }>;
}

export type ColorSpec = SolidColor | GradientColor;

export interface LogoSpec {
  /** Data URI or remote URL. Designer always uses data URIs so the spec is
   *  self-contained and serializable. */
  src: string | null;
  /** Fraction of the QR symbol the image occupies (0..1). 0.2 is a safe
   *  default with error correction "H" (~30% redundancy). */
  size: number;
  /** Margin around the image in QR modules. */
  margin: number;
  /** Whether to leave a clean white square behind the logo (recommended). */
  hideBackgroundDots: boolean;
}

export interface FrameSpec {
  /** "none" = bare QR; "callout" = rounded background with a ribbon below;
   *  "ribbon" = no background, just a tagline strip below the QR. */
  kind: 'none' | 'callout' | 'ribbon';
  /** Text rendered in the ribbon. Empty disables the ribbon visually. */
  text: string;
  /** Frame fill color (callout background). */
  fill: string;
  /** Text + accent color used in the ribbon. */
  accent: string;
  /** Color of the QR cell background within the frame. */
  innerBackground: string;
  /** Corner radius of the outer card. */
  cornerRadius: number;
}

export interface QrStyleSpec {
  /** The string encoded by the QR code. */
  data: string;
  /** Symbol error correction. Higher = bigger code but tolerates more
   *  occlusion (good when embedding a logo). */
  errorCorrection: 'L' | 'M' | 'Q' | 'H';
  /** Modules of quiet zone (white border). 4 is QR-spec; 2 looks tighter. */
  quietZoneModules: number;
  /** Module ("dot") shape. */
  dotShape: DotShape;
  /** Foreground color/gradient applied to the modules. */
  dotColor: ColorSpec;
  /** Eye (finder pattern) outer ring shape + color. */
  eyeOuterShape: EyeOuterShape;
  eyeOuterColor: ColorSpec;
  /** Eye inner dot shape + color. */
  eyeInnerShape: EyeInnerShape;
  eyeInnerColor: ColorSpec;
  /** Background color of the QR cell itself. */
  background: ColorSpec;
  /** Embedded logo image. */
  logo: LogoSpec;
  /** Optional surrounding frame/ribbon. */
  frame: FrameSpec;
}

// -----------------------------------------------------------------------------
// Defaults
// -----------------------------------------------------------------------------

export const DEFAULT_QR_SPEC: QrStyleSpec = {
  data: 'https://example.com',
  errorCorrection: 'H',
  quietZoneModules: 4,
  dotShape: 'rounded',
  dotColor: { mode: 'solid', color: '#0a0c0f' },
  eyeOuterShape: 'extra-rounded',
  eyeOuterColor: { mode: 'solid', color: '#0a0c0f' },
  eyeInnerShape: 'dot',
  eyeInnerColor: { mode: 'solid', color: '#0a0c0f' },
  background: { mode: 'solid', color: '#ffffff' },
  logo: {
    src: null,
    size: 0.22,
    margin: 4,
    hideBackgroundDots: true,
  },
  frame: {
    kind: 'none',
    text: 'SCAN ME',
    fill: '#0a0c0f',
    accent: '#ffffff',
    innerBackground: '#ffffff',
    cornerRadius: 24,
  },
};

// -----------------------------------------------------------------------------
// Engine adapter — translate a QrStyleSpec into qr-code-styling's options.
// -----------------------------------------------------------------------------

function toEngineColor(c: ColorSpec): {
  color?: string;
  gradient?: NonNullable<NonNullable<EngineOptions['dotsOptions']>['gradient']>;
} {
  if (c.mode === 'solid') return { color: c.color };
  return {
    gradient: {
      type: c.mode,
      rotation: (c.rotation * Math.PI) / 180,
      colorStops: c.stops.map((s) => ({ offset: s.offset, color: s.color })),
    },
  };
}

export function toEngineOptions(spec: QrStyleSpec, width: number): EngineOptions {
  const opts: EngineOptions = {
    type: 'svg',
    width,
    height: width,
    data: spec.data || ' ',
    margin: spec.quietZoneModules,
    image: spec.logo.src ?? undefined,
    qrOptions: {
      errorCorrectionLevel: spec.errorCorrection,
    },
    imageOptions: {
      // Critical: the library defaults to saveAsBlob: true, which fetches the
      // image URI to convert it to a blob before embedding. With a data:
      // URI that's a self-fetch — and the admin app's CSP connect-src does
      // not include `data:`, so the request is blocked and the engine
      // throws. Disabling saveAsBlob lets the library use the image URI
      // directly via <img src> / <image href>, which goes through img-src
      // (where data: is allowed by default).
      saveAsBlob: false,
      hideBackgroundDots: spec.logo.hideBackgroundDots,
      imageSize: spec.logo.size * 2, // engine scales differently — empirically *2 matches Bitly-like sizing
      margin: spec.logo.margin,
      crossOrigin: 'anonymous',
    },
    dotsOptions: {
      type: spec.dotShape,
      ...toEngineColor(spec.dotColor),
    },
    cornersSquareOptions: {
      type: spec.eyeOuterShape,
      ...toEngineColor(spec.eyeOuterColor),
    },
    cornersDotOptions: {
      type: spec.eyeInnerShape,
      ...toEngineColor(spec.eyeInnerColor),
    },
    backgroundOptions: {
      ...toEngineColor(spec.background),
    },
  };
  return opts;
}

// -----------------------------------------------------------------------------
// Filename helper
// -----------------------------------------------------------------------------

export function specToFilenameRoot(spec: QrStyleSpec): string {
  // Use the URL host if the data looks like a URL, otherwise the first 20
  // chars of the content, sanitized to a filename-safe slug.
  let label = spec.data;
  try {
    const u = new URL(spec.data);
    label = u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, '');
  } catch {
    // not a URL
  }
  return (
    label
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'qr-code'
  );
}
