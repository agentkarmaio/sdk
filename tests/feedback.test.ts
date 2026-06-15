import { describe, expect, it } from 'bun:test';
import { AgentKarmaValidationError, buildFeedbackMessage } from '../src/index.js';

describe('buildFeedbackMessage', () => {
  it('produces the exact server-expected format', () => {
    const out = buildFeedbackMessage({
      rating: 'delivered',
      txSignature: 'abc123',
      timestamp: 1717000000000,
    });
    expect(out.message).toBe('AgentKarma: Feedback delivered for abc123 at 1717000000000');
    expect(out.timestamp).toBe(1717000000000);
  });

  it('uses Date.now() when no timestamp provided', () => {
    const before = Date.now();
    const out = buildFeedbackMessage({ rating: 'failed', txSignature: 'sig' });
    const after = Date.now();
    expect(out.timestamp).toBeGreaterThanOrEqual(before);
    expect(out.timestamp).toBeLessThanOrEqual(after);
    expect(out.message).toBe(`AgentKarma: Feedback failed for sig at ${out.timestamp}`);
  });

  it('throws on invalid rating', () => {
    expect(() =>
      buildFeedbackMessage({ rating: 'pending' as never, txSignature: 'sig' }),
    ).toThrow(AgentKarmaValidationError);
  });

  it('throws on missing txSignature', () => {
    expect(() =>
      buildFeedbackMessage({ rating: 'delivered', txSignature: '' }),
    ).toThrow(AgentKarmaValidationError);
  });

  it('throws on non-positive timestamp', () => {
    expect(() =>
      buildFeedbackMessage({ rating: 'delivered', txSignature: 'sig', timestamp: -1 }),
    ).toThrow(AgentKarmaValidationError);
  });
});
