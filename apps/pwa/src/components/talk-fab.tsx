'use client';

import { Mic } from 'lucide-react';

// Floating "Talk" pill anchored bottom-right above the tab bar — the
// re-entry point for voice mode after the user dismisses it. The chat
// composer has its own mic icon, so this only renders on non-chat tabs.

interface Props {
  onClick: () => void;
}

export function TalkFab({ onClick }: Props) {
  return (
    <button
      type="button"
      className="app-talk-fab"
      onClick={onClick}
      aria-label="Open voice assistant"
    >
      <Mic size={16} strokeWidth={2.25} />
      <span>Talk</span>
    </button>
  );
}
