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
        style={{ width: 22, height: 22, fontSize: 10 }}
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
        style={{ maxHeight: 22, maxWidth: 120, objectFit: 'contain' }}
        onError={() => setFailed(true)}
      />
    </ImageZoom>
  );
}
