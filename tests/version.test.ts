/**
 * SDK_VERSION drift guard — the User-Agent header advertises SDK_VERSION, and
 * it silently under-reported (0.1.0) for two releases because nothing tied it
 * to package.json. This test makes the drift a release-blocking failure.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { SDK_VERSION } from '../src/client.js';

describe('SDK_VERSION', () => {
  it('matches package.json version', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
    ) as { version: string };
    expect(SDK_VERSION).toBe(pkg.version);
  });
});
