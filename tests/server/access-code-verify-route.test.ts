import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ACCESS_TOKEN_MAX_AGE_SECONDS } from '@/lib/server/access-token-shared';

const mocks = vi.hoisted(() => ({
  cookieSet: vi.fn(),
  takeAttempt: vi.fn(),
  resolveKeys: vi.fn(),
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ set: mocks.cookieSet }) }));
vi.mock('@/lib/server/access-code-rate-limit', () => ({
  takeAccessCodeAttempt: mocks.takeAttempt,
  resolveAccessCodeRateLimitKeys: mocks.resolveKeys,
}));
import { POST } from '@/app/api/access-code/verify/route';

const ACCESS_CODE = 'omc_jmZ633OgDh2O7NZel4OUjqYO-hDTNmKWYXBUQvbsI1I';
function request(body: unknown = { code: ACCESS_CODE }) {
  return new NextRequest('http://localhost/api/access-code/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.1' },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.stubEnv('ACCESS_CODE', ACCESS_CODE);
  vi.stubEnv('DATABASE_URL', 'postgres://rate-limit.example/openmaic');
  vi.stubEnv('ACCESS_CODE_TRUSTED_IP_HEADER', 'x-real-ip');
  mocks.cookieSet.mockReset();
  mocks.takeAttempt.mockReset().mockResolvedValue({ allowed: true });
  mocks.resolveKeys.mockReset().mockReturnValue({ globalKey: 'global', sourceKey: 'source' });
});
afterEach(() => vi.unstubAllEnvs());

describe('POST /api/access-code/verify — shared persistent throttling', () => {
  it('requires a securely generated access code before consuming an attempt', async () => {
    vi.stubEnv('ACCESS_CODE', 'demo-code');
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(mocks.takeAttempt).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });
  it.each(['DATABASE_URL', 'ACCESS_CODE_TRUSTED_IP_HEADER'])(
    'requires %s for shared throttling',
    async (key) => {
      vi.stubEnv(key, '');
      expect((await POST(request())).status).toBe(503);
      expect(mocks.takeAttempt).not.toHaveBeenCalled();
    },
  );
  it('reserves the shared attempt before parsing the body', async () => {
    const req = request();
    const parse = vi.spyOn(req, 'json');
    mocks.takeAttempt.mockImplementation(async () => {
      expect(parse).not.toHaveBeenCalled();
      return { allowed: true };
    });
    expect((await POST(req)).status).toBe(200);
    expect(mocks.takeAttempt).toHaveBeenCalledWith({ globalKey: 'global', sourceKey: 'source' });
  });
  it('refuses exhausted global or per-source budgets before reading a body', async () => {
    mocks.takeAttempt.mockResolvedValue({ allowed: false, retryAfterSeconds: 37 });
    const req = request();
    const parse = vi.spyOn(req, 'json');
    const response = await POST(req);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('37');
    expect(parse).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });
  it('fails closed when the shared limiter is unavailable', async () => {
    mocks.takeAttempt.mockRejectedValue(new Error('private database connection failure'));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('private database');
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });
  it('fails closed when the trusted reverse proxy did not provide an identity', async () => {
    mocks.resolveKeys.mockImplementation(() => {
      throw new Error('Missing trusted IP');
    });
    expect((await POST(request())).status).toBe(503);
    expect(mocks.takeAttempt).not.toHaveBeenCalled();
  });
  it.each([null, {}, [], { code: 5 }, { code: '' }, { code: 'wrong' }])(
    'refuses malformed or incorrect candidate %j after reserving an attempt',
    async (body) => {
      expect((await POST(request(body))).status).toBe(401);
      expect(mocks.takeAttempt).toHaveBeenCalledOnce();
      expect(mocks.cookieSet).not.toHaveBeenCalled();
    },
  );
  it('returns a controlled error for malformed JSON', async () => {
    const req = request();
    vi.spyOn(req, 'json').mockRejectedValue(new SyntaxError('bad JSON'));
    expect((await POST(req)).status).toBe(400);
    expect(mocks.takeAttempt).toHaveBeenCalledOnce();
  });
  it('sets an HTTP-only access cookie with the shared token lifetime', async () => {
    expect((await POST(request())).status).toBe(200);
    expect(mocks.cookieSet).toHaveBeenCalledWith(
      'openmaic_access',
      expect.any(String),
      expect.objectContaining({
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: ACCESS_TOKEN_MAX_AGE_SECONDS,
      }),
    );
  });
  it('allows an unset access code without contacting the limiter', async () => {
    vi.stubEnv('ACCESS_CODE', '');
    expect((await POST(request())).status).toBe(200);
    expect(mocks.takeAttempt).not.toHaveBeenCalled();
  });
});
