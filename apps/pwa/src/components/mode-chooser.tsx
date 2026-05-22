'use client';

import { LayoutGrid, Mic } from 'lucide-react';

// First-touch picker shown on every QR scan. Two options:
//   - Hands-Free: opens VoiceMode immediately (mic + AI voice)
//   - Browse:    drops the tech into the asset hub to tap through docs/parts
// Choice is intentional and not remembered — see plan for rationale.

export type ChosenMode = 'voice' | 'browse';

interface Props {
  assetName: string;
  onPick: (mode: ChosenMode) => void;
}

export function ModeChooser({ assetName, onPick }: Props) {
  return (
    <div
      className="mode-chooser-root"
      role="dialog"
      aria-modal="true"
      aria-label="Choose how to work"
    >
      <div className="mode-chooser-asset">
        <div className="mode-chooser-asset-name">{assetName}</div>
      </div>

      <h1 className="mode-chooser-title">Choose a work mode</h1>

      <div className="mode-chooser-options">
        <button type="button" className="mode-chooser-card" onClick={() => onPick('voice')}>
          <span className="mode-chooser-card-icon" data-tone="brand">
            <Mic size={26} strokeWidth={2} />
          </span>
          <span className="mode-chooser-card-text">
            <span className="mode-chooser-card-title">Voice assistant</span>
            <span className="mode-chooser-card-sub">
              Hands-free troubleshooting and walkthroughs
            </span>
          </span>
        </button>

        <button type="button" className="mode-chooser-card" onClick={() => onPick('browse')}>
          <span className="mode-chooser-card-icon">
            <LayoutGrid size={26} strokeWidth={2} />
          </span>
          <span className="mode-chooser-card-text">
            <span className="mode-chooser-card-title">Equipment dashboard</span>
            <span className="mode-chooser-card-sub">Work orders, PMs, parts, and documents</span>
          </span>
        </button>
      </div>
    </div>
  );
}
