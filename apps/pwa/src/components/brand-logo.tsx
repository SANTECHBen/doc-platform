'use client';

import { useState } from 'react';

// OEM brand mark shown in the asset hub topbar. Renders as a tappable
// button when onClick is provided — used by the topbar to send the
// tech back to Overview on tap (the brand-mark-as-home pattern every
// mobile app converges on).
//
// Earlier versions wrapped the logo in <ImageZoom>, which made a tap
// open a zoom modal of the corporate logo. That's never useful, and
// users reading the logo as "home" got the wrong affordance instead.
export function BrandLogo({
  src,
  alt,
  initials,
  onClick,
}: {
  src: string;
  alt: string;
  initials: string;
  onClick?: () => void;
}): React.ReactElement {
  const [failed, setFailed] = useState(false);

  const content = failed ? (
    <div className="brand-mark-square" style={{ width: 36, height: 36, fontSize: 14 }}>
      {initials}
    </div>
  ) : (
    <img
      src={src}
      alt={alt}
      style={{ maxHeight: 40, maxWidth: 200, objectFit: 'contain' }}
      onError={() => setFailed(true)}
    />
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="brand-logo-button"
        aria-label={`${alt} — return to Overview`}
      >
        {content}
      </button>
    );
  }
  return content;
}
