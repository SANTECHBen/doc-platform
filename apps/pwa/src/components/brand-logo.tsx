'use client';

import { useState } from 'react';
import { ImageZoom } from './image-zoom';

export function BrandLogo({
  src,
  alt,
  initials,
}: {
  src: string;
  alt: string;
  initials: string;
}): React.ReactElement {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div
        className="brand-mark-square"
        style={{ width: 36, height: 36, fontSize: 14 }}
      >
        {initials}
      </div>
    );
  }

  return (
    <ImageZoom src={src} alt={alt} triggerLabel={`Enlarge ${alt} logo`}>
      <img
        src={src}
        alt={alt}
        style={{ maxHeight: 40, maxWidth: 200, objectFit: 'contain' }}
        onError={() => setFailed(true)}
      />
    </ImageZoom>
  );
}
