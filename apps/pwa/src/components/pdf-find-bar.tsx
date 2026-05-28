'use client';

// PdfFindBar — the "Find" toolbar shown above a PDF in the Library viewer.
// Mirrors Acrobat's Ctrl+F bar: query input, match counter, prev/next, plus
// case-sensitive and whole-word toggles. All search state lives in
// usePdfSearch; this component is presentation + keyboard handling only.

import { useEffect, useRef } from 'react';
import {
  CaseSensitive,
  ChevronDown,
  ChevronUp,
  Loader2,
  Search,
  WholeWord,
  X,
} from 'lucide-react';

export interface PdfFindBarProps {
  query: string;
  onQueryChange: (q: string) => void;

  matchCount: number;
  activeIndex: number; // -1 when no active match
  truncated: boolean;

  indexing: boolean;
  indexedCount: number;
  totalPages: number;
  hasText: boolean;

  caseSensitive: boolean;
  onToggleCase: () => void;
  wholeWord: boolean;
  onToggleWholeWord: () => void;

  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;

  /** Bumping this re-focuses (and selects) the input — used when Ctrl+F is
   *  pressed again while the bar is already open. */
  focusTick: number;
}

export function PdfFindBar(props: PdfFindBarProps) {
  const {
    query,
    onQueryChange,
    matchCount,
    activeIndex,
    truncated,
    indexing,
    indexedCount,
    totalPages,
    hasText,
    caseSensitive,
    onToggleCase,
    wholeWord,
    onToggleWholeWord,
    onNext,
    onPrev,
    onClose,
    focusTick,
  } = props;

  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [focusTick]);

  const hasQuery = query.trim().length > 0;
  const noResults = hasQuery && matchCount === 0 && !indexing;

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) onPrev();
      else onNext();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  // Status text, announced politely so screen-reader users hear the count.
  let status: string;
  if (!hasText && !indexing && totalPages > 0) {
    status = 'No searchable text';
  } else if (!hasQuery) {
    status = '';
  } else if (matchCount === 0) {
    status = indexing ? 'Searching…' : 'No results';
  } else {
    status = `${activeIndex + 1} of ${matchCount}${truncated ? '+' : ''}`;
  }

  const navDisabled = matchCount === 0;

  return (
    <div className="pdf-find-bar" role="search">
      <Search size={15} strokeWidth={2} className="pdf-find-bar__lead" aria-hidden />

      <input
        ref={inputRef}
        type="text"
        inputMode="search"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        className="pdf-find-bar__input"
        placeholder="Find in document"
        aria-label="Find in document"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
      />

      <span
        className={`pdf-find-bar__count${noResults ? ' pdf-find-bar__count--empty' : ''}`}
        aria-live="polite"
      >
        {status}
      </span>

      {indexing && (
        <span className="pdf-find-bar__indexing" title="Indexing document text">
          <Loader2 size={13} strokeWidth={2.5} className="pdf-find-bar__spin" aria-hidden />
          <span className="pdf-find-bar__indexing-text">
            {indexedCount}/{totalPages}
          </span>
        </span>
      )}

      <div className="pdf-find-bar__divider" aria-hidden />

      <button
        type="button"
        className={`pdf-find-bar__toggle${caseSensitive ? ' is-active' : ''}`}
        aria-pressed={caseSensitive}
        title="Match case"
        aria-label="Match case"
        onClick={onToggleCase}
      >
        <CaseSensitive size={17} strokeWidth={2} aria-hidden />
      </button>
      <button
        type="button"
        className={`pdf-find-bar__toggle${wholeWord ? ' is-active' : ''}`}
        aria-pressed={wholeWord}
        title="Whole words only"
        aria-label="Whole words only"
        onClick={onToggleWholeWord}
      >
        <WholeWord size={17} strokeWidth={2} aria-hidden />
      </button>

      <div className="pdf-find-bar__divider" aria-hidden />

      <button
        type="button"
        className="pdf-find-bar__nav"
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
        disabled={navDisabled}
        onClick={onPrev}
      >
        <ChevronUp size={16} strokeWidth={2.25} aria-hidden />
      </button>
      <button
        type="button"
        className="pdf-find-bar__nav"
        title="Next match (Enter)"
        aria-label="Next match"
        disabled={navDisabled}
        onClick={onNext}
      >
        <ChevronDown size={16} strokeWidth={2.25} aria-hidden />
      </button>

      <button
        type="button"
        className="pdf-find-bar__close"
        title="Close (Esc)"
        aria-label="Close find bar"
        onClick={onClose}
      >
        <X size={16} strokeWidth={2.25} aria-hidden />
      </button>
    </div>
  );
}
