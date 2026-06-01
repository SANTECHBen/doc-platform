import { describe, expect, it } from 'vitest';
import { ensureTerminalPeriod } from './doc-loop.js';

describe('ensureTerminalPeriod', () => {
  it('appends a period when the instruction has no terminal punctuation', () => {
    expect(ensureTerminalPeriod('Remove the bearing')).toBe('Remove the bearing.');
  });

  it('leaves existing sentence punctuation alone', () => {
    expect(ensureTerminalPeriod('Is the seal intact?')).toBe('Is the seal intact?');
    expect(ensureTerminalPeriod('Stop immediately!')).toBe('Stop immediately!');
    expect(ensureTerminalPeriod('Torque the bolts to 25 Nm.')).toBe('Torque the bolts to 25 Nm.');
  });

  it('does not double-punctuate or touch a trailing colon', () => {
    expect(ensureTerminalPeriod('Tools required:')).toBe('Tools required:');
  });

  it('trims trailing whitespace before adding the period', () => {
    expect(ensureTerminalPeriod('Disconnect the power cable   ')).toBe(
      'Disconnect the power cable.',
    );
  });

  it('returns empty input untouched', () => {
    expect(ensureTerminalPeriod('')).toBe('');
    expect(ensureTerminalPeriod('   ')).toBe('');
  });

  it('keeps the result within maxLen when appending would overflow', () => {
    const t = 'a'.repeat(200); // exactly at the title bound, no punctuation
    const out = ensureTerminalPeriod(t, 200);
    expect(out.length).toBe(200);
    expect(out.endsWith('.')).toBe(true);
  });

  it('clamps an already-punctuated string that exceeds maxLen', () => {
    const out = ensureTerminalPeriod(`${'a'.repeat(205)}.`, 200);
    expect(out.length).toBe(200);
  });
});
