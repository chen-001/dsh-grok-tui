/**
 * Unit tests for the tmux usage panel (scripts/usage-panel.mjs): the TTFT/TPS
 * rows, the active-session footer, and the defensive formatting of missing
 * metrics.
 */

import { describe, expect, it } from '@rstest/core';
import {
  fmtDuration,
  fmtTokens,
  fmtTps,
  renderView,
} from '../scripts/usage-panel.mjs';

describe('usage panel formatting', () => {
  it('formats token counts in the herdr M-primary style', () => {
    expect(fmtTokens(0)).toBe('0');
    expect(fmtTokens(999)).toBe('999');
    expect(fmtTokens(1_234)).toBe('0.001M');
    expect(fmtTokens(12_345_678)).toBe('12.35M');
    expect(fmtTokens(1.2e9)).toBe('1.20B');
  });

  it('formats durations and TPS, with a dash for missing values', () => {
    expect(fmtDuration(812)).toBe('812ms');
    expect(fmtDuration(4_500)).toBe('4.5s');
    expect(fmtDuration(125_000)).toBe('2m5s');
    expect(fmtDuration(undefined)).toBe('–');
    expect(fmtTps(42.7)).toBe('42.7/s');
    expect(fmtTps(undefined)).toBe('–');
  });
});

describe('usage panel render', () => {
  const usage = {
    inputTokens: 1_234,
    outputTokens: 5_678,
    cacheReadTokens: 9_000,
    cacheWriteTokens: 100,
    apiCalls: 3,
    toolDurationMs: 4_500,
    pressureTokens: 10_334,
    ttftMs: 812,
    tps: 42.7,
  };

  it('renders the TTFT and TPS rows', () => {
    const out = renderView({ sessionId: 'sess-abc', usage });
    expect(out).toContain('│ ttft            812ms             │');
    expect(out).toContain('│ tps            42.7/s             │');
    expect(out).toContain('session sess-abc… — q to close');
  });

  it('shows a dash when TTFT/TPS are not available yet', () => {
    const out = renderView({
      sessionId: 'sess-abc',
      usage: { ...usage, ttftMs: undefined, tps: undefined },
    });
    expect(out).toContain('│ ttft                –             │');
    expect(out).toContain('│ tps                 –             │');
  });

  it('marks a session switch in the footer', () => {
    const out = renderView({ sessionId: 'sess-abc', usage }, true);
    expect(out).toContain('session sess-abc… (switched) — q to close');
  });

  it('survives a status file without a usage object', () => {
    const out = renderView({ sessionId: 'sess-abc' });
    expect(out).toContain('│ cache hit        –%  (0 read) │');
    expect(out).toContain('│ ttft                –             │');
  });
});
