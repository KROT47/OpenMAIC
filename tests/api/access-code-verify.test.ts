import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setCookie: vi.fn(),
  getCookie: vi.fn(),
  takeAttempt: vi.fn(),
  resolveKeys: vi.fn(),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ set: mocks.setCookie, get: mocks.getCookie }),
}));
vi.mock('@/lib/server/access-code-rate-limit', () => ({
  takeAccessCodeAttempt: mocks.takeAttempt,
  resolveAccessCodeRateLimitKeys: mocks.resolveKeys,
}));

import { POST } from '@/app/api/access-code/verify/route';
import { GET } from '@/app/api/access-code/status/route';
import { ACCESS_TOKEN_MAX_AGE_SECONDS } from '@/lib/access-token-policy';

const ACCESS_CODE = 'omc_jmZ633OgDh2O7NZel4OUjqYO-hDTNmKWYXBUQvbsI1I';

function request(code?: string): Request {
  return new Request('http://localhost/api/access-code/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(code === undefined ? {} : { code }),
  });
}

beforeEach(() => {
  process.env.ACCESS_CODE = ACCESS_CODE;
  process.env.DATABASE_URL = 'postgres://rate-limit.example/openmaic';
  process.env.ACCESS_CODE_TRUSTED_IP_HEADER = 'x-real-ip';
  mocks.setCookie.mockReset();
  mocks.getCookie.mockReset();
  mocks.takeAttempt.mockReset().mockResolvedValue({ allowed: true });
  mocks.resolveKeys.mockReset().mockReturnValue({ globalKey: 'global', sourceKey: 'source' });
  vi.setSystemTime(new Date('2026-09-08T00:00:00Z'));
});

afterEach(() => {
  delete process.env.ACCESS_CODE;
  delete process.env.DATABASE_URL;
  delete process.env.ACCESS_CODE_TRUSTED_IP_HEADER;
  vi.useRealTimers();
});

describe('POST /api/access-code/verify', () => {
  it('fails closed when ACCESS_CODE is human-selected or legacy', async () => {
    process.env.ACCESS_CODE = 'correct-horse';
    const blocked = await POST(request('correct-horse'));
    expect(blocked.status).toBe(503);
    await expect(blocked.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'INVALID_CONFIGURATION',
    });
    expect(mocks.setCookie).not.toHaveBeenCalled();

    await expect(GET().then((response) => response.json())).resolves.toMatchObject({
      success: true,
      enabled: true,
      authenticated: false,
      configurationValid: false,
    });
  });

  it('uses the same seven-day lifetime as token verification', async () => {
    const response = await POST(request(ACCESS_CODE));
    expect(response.status).toBe(200);
    expect(mocks.setCookie).toHaveBeenCalledWith(
      'openmaic_access',
      expect.any(String),
      expect.objectContaining({ maxAge: ACCESS_TOKEN_MAX_AGE_SECONDS }),
    );
  });

  it('returns 429 before comparing when the shared budget is exhausted', async () => {
    mocks.takeAttempt.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 37 });

    const response = await POST(request(ACCESS_CODE));

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('37');
    expect(mocks.setCookie).not.toHaveBeenCalled();
  });
});
