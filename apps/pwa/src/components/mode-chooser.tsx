'use client';

import { LayoutGrid, Mic } from 'lucide-react';

// First-touch picker shown on every QR scan. Two options:
//   - Hands-Free: opens VoiceMode immediately (mic + AI voice)
//   - Browse:    drops the tech into the asset hub to tap through docs/parts
// Choice is intentional and not remembered — see plan for rationale.

export type ChosenMode = 'voice' | 'browse';

interface Props {
  assetName: string;
  serialNumber: string;
  onPick: (mode: ChosenMode) => void;
}

export function ModeChooser({ assetName, serialNumber, onPick }: Props) {
  return (
    <div className="mode-chooser-root" role="dialog" aria-label="Choose how to work">
      <div className="mode-chooser-asset">
        <div className="mode-chooser-asset-name">{assetName}</div>
        <div className="mode-chooser-asset-serial">S/N {serialNumber}</div>
      </div>

      <h1 className="mode-chooser-title">How would you like to work?</h1>

      <div className="mode-chooser-options">
        <button
          type="button"
          className="mode-chooser-card"
          onClick={() => onPick('voice')}
        >
          <span className="mode-chooser-card-icon" data-tone="brand">
            <Mic size={26} strokeWidth={2} />
          </span>
          <span className="mode-chooser-card-text">
            <span className="mode-chooser-card-title">Hands-Free</span>
            <span className="mode-chooser-card-sub">Talk to the assistant</span>
          </span>
        </button>

        <button
          type="button"
          className="mode-chooser-card"
          onClick={() => onPick('browse')}
        >
          <span className="mode-chooser-card-icon">
            <LayoutGrid size={26} strokeWidth={2} />
          </span>
          <span className="mode-chooser-card-text">
            <span className="mode-chooser-card-title">Browse</span>
            <span className="mode-chooser-card-sub">Tap through docs &amp; parts</span>
          </span>
        </button>
      </div>
    </div>
  );
}
