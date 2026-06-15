/**
 * Wallet-agnostic helpers for building consumer feedback messages.
 *
 * The server expects an Ed25519 signature (Solana-flavored) over a specific
 * message string. This module produces the message; the SDK never asks for a
 * private key. The caller signs externally and passes the signature to
 * `client.submitFeedback()`.
 *
 * The message format is fixed by the server (see
 * `web/src/app/api/feedback/route.ts`):
 *
 *   AgentKarma: Feedback {rating} for {txSignature} at {timestamp}
 *
 * `{timestamp}` is Date.now() in milliseconds. The server enforces a 5-minute
 * freshness window — don't pre-build messages and use them later.
 */

import { AgentKarmaValidationError } from './errors.js';
import type { FeedbackRating } from './types.js';

export interface BuildFeedbackMessageInput {
  rating: FeedbackRating;
  txSignature: string;
  /** Defaults to Date.now() at call time. Server allows ±5 minutes. */
  timestamp?: number;
}

export interface BuiltFeedbackMessage {
  /** The exact string to sign with the consumer wallet. */
  message: string;
  /** Timestamp embedded in the message — pass through to `submitFeedback()`. */
  timestamp: number;
}

export function buildFeedbackMessage(input: BuildFeedbackMessageInput): BuiltFeedbackMessage {
  if (!input || typeof input !== 'object') {
    throw new AgentKarmaValidationError('input is required');
  }
  if (input.rating !== 'delivered' && input.rating !== 'failed') {
    throw new AgentKarmaValidationError(`rating must be 'delivered' or 'failed'`);
  }
  if (!input.txSignature || typeof input.txSignature !== 'string') {
    throw new AgentKarmaValidationError('txSignature must be a non-empty string');
  }
  const timestamp = input.timestamp ?? Date.now();
  if (!Number.isInteger(timestamp) || timestamp <= 0) {
    throw new AgentKarmaValidationError('timestamp must be a positive integer (ms)');
  }
  const message = `AgentKarma: Feedback ${input.rating} for ${input.txSignature} at ${timestamp}`;
  return { message, timestamp };
}
