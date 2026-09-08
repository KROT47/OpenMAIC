import { describe, expect, test, vi } from 'vitest';

import { createAccessToken, verifyAccessToken } from '@/lib/server/access-token';

const ACCESS_CODE = 'omc_jmZ633OgDh2O7NZel4OUjqYO-hDTNmKWYXBUQvbsI1I';
const OTHER_ACCESS_CODE = 'omc_MGWUc6BbShYLur-IQ_lFP35xqPhV1TeIFz2Z9Knr6Rc';

describe('access token signing', () => {
  test('verifies tokens signed with the same access code', () => {
    vi.setSystemTime(new Date('2026-06-25T00:00:00Z'));

    const token = createAccessToken(ACCESS_CODE);

    expect(verifyAccessToken(token, ACCESS_CODE)).toBe(true);
    expect(verifyAccessToken(token, OTHER_ACCESS_CODE)).toBe(false);
    expect(verifyAccessToken('bad-token', ACCESS_CODE)).toBe(false);

    vi.useRealTimers();
  });

  test('rejects expired and far-future tokens', () => {
    const now = new Date('2026-06-25T00:00:00Z').getTime();
    vi.setSystemTime(now);
    const token = createAccessToken(ACCESS_CODE);
    expect(verifyAccessToken(token, ACCESS_CODE, now + 8 * 24 * 60 * 60 * 1000)).toBe(false);

    vi.setSystemTime(now + 2 * 60 * 1000);
    const futureToken = createAccessToken(ACCESS_CODE);
    expect(verifyAccessToken(futureToken, ACCESS_CODE, now)).toBe(false);
    vi.useRealTimers();
  });

  test('rejects human-selected and legacy access codes', () => {
    expect(() => createAccessToken('demo-code')).toThrow(/43 base64url/);
    expect(verifyAccessToken('bad-token', 'demo-code')).toBe(false);
  });
});
