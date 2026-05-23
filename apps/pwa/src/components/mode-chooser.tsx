'use client';

import { LayoutGrid, Mic, Search } from 'lucide-react';

// First-touch picker shown on every QR scan. Two options:
//   - Hands-Free: opens VoiceMode immediately (mic + AI voice)
//   - Browse:    drops the tech into the asset hub to tap through docs/parts
// Choice is intentional and not remembered — see plan for rationale.
//
// A footnote points at the Voice search affordance in Browse mode so techs
// know lookup-only is one tap away (no conversation overhead).

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
              Conversation: troubleshoot or walk through a procedure hands-free
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

      {/* Footnote pointing at the topbar search icon — explains the
          distinction so a tech who really wants a one-shot lookup (not a
          conversation) knows where to go without picking Voice and
          backing out. */}
      <p className="mode-chooser-footnote">
        <Search size={12} strokeWidth={2.25} aria-hidden />
        <span>
          Looking for a specific procedure or step? Tap the search icon in
          the top bar after picking <strong>Equipment dashboard</strong>.
        </span>
      </p>
    </div>
  );
}
