import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { APICallError } from 'ai';

const mocks = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  callLLM: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModel: mocks.resolveModel,
  getExpectedResolvedModelFromHeaders: (req: NextRequest) => {
    const providerId = req.headers.get('x-openmaic-expected-provider');
    const modelId = req.headers.get('x-openmaic-expected-model');
    return providerId && modelId ? { providerId, modelId } : undefined;
  },
}));

vi.mock('@/lib/ai/llm', () => ({
  callLLM: mocks.callLLM,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: mocks.logError,
    debug: vi.fn(),
  }),
}));

async function postVerifyModel(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/verify-model/route');
  const request = new Request('http://localhost/api/verify-model', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(request as unknown as NextRequest);
}

async function postAcceptanceVerifyModel(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/verify-model/route');
  const request = new Request('http://localhost/api/verify-model', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-openmaic-expected-provider': 'openai-codex',
      'x-openmaic-expected-model': 'gpt-5.5',
    },
    body: JSON.stringify(body),
  });
  return POST(request as unknown as NextRequest);
}

describe('POST /api/verify-model', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.resolveModel.mockReset();
    mocks.callLLM.mockReset();
    mocks.logError.mockReset();
    mocks.resolveModel.mockResolvedValue({ model: { id: 'language-model' } });
    mocks.callLLM.mockResolvedValue({ text: 'OK' });
  });

  it('rejects requests without a model name', async () => {
    const res = await postVerifyModel({});
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toMatchObject({
      success: false,
      errorCode: 'MISSING_REQUIRED_FIELD',
    });
    expect(mocks.resolveModel).not.toHaveBeenCalled();
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it.each([
    ['number', 123],
    ['object', { provider: 'openai-codex', id: 'gpt-5.5' }],
    ['array', ['openai-codex:gpt-5.5']],
    ['blank string', '   '],
  ])('rejects an untrusted %s model value without throwing', async (_label, model) => {
    const res = await postVerifyModel({ model });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toMatchObject({
      success: false,
      errorCode: 'MISSING_REQUIRED_FIELD',
      error: 'Model name is required',
    });
    expect(mocks.resolveModel).not.toHaveBeenCalled();
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('uses the unified LLM wrapper with thinking disabled for connection checks', async () => {
    const res = await postVerifyModel({
      model: 'xiaomi:mimo-v2.5-pro',
      apiKey: 'tp-test',
      baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
      providerType: 'openai',
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({
      success: true,
      message: 'Connection successful',
      response: 'OK',
    });
    expect(mocks.resolveModel).toHaveBeenCalledWith({
      modelString: 'xiaomi:mimo-v2.5-pro',
      apiKey: 'tp-test',
      baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
      providerType: 'openai',
    });
    expect(mocks.callLLM).toHaveBeenCalledWith(
      {
        model: { id: 'language-model' },
        prompt: 'Say "OK" if you can hear me.',
        maxOutputTokens: 64,
      },
      'verify-model',
      undefined,
      { mode: 'disabled', enabled: false },
    );
  });

  it('accepts a credential-free Codex connection request', async () => {
    const res = await postVerifyModel({ model: 'openai-codex:gpt-5.5' });

    expect(res.status).toBe(200);
    expect(mocks.resolveModel).toHaveBeenCalledWith({
      modelString: 'openai-codex:gpt-5.5',
      apiKey: '',
      baseUrl: undefined,
      providerType: undefined,
    });
  });

  it('forwards the acceptance resolved-model assertion before verification generation', async () => {
    const res = await postAcceptanceVerifyModel({ model: 'openai-codex:gpt-5.5' });

    expect(res.status).toBe(200);
    expect(mocks.resolveModel).toHaveBeenCalledWith({
      modelString: 'openai-codex:gpt-5.5',
      apiKey: '',
      baseUrl: undefined,
      providerType: undefined,
      expectedResolvedModel: { providerId: 'openai-codex', modelId: 'gpt-5.5' },
    });
  });

  it('forwards only the exact priority tier for a credential-free Codex check', async () => {
    const res = await postVerifyModel({
      model: 'openai-codex:gpt-5.5',
      serviceTier: 'priority',
    });

    expect(res.status).toBe(200);
    expect(mocks.resolveModel).toHaveBeenCalledWith({
      modelString: 'openai-codex:gpt-5.5',
      apiKey: '',
      baseUrl: undefined,
      providerType: undefined,
      serviceTier: 'priority',
    });

    mocks.resolveModel.mockClear();
    await postVerifyModel({
      model: 'openai-codex:gpt-5.5',
      serviceTier: 'priority ',
    });
    expect(mocks.resolveModel).toHaveBeenCalledWith({
      modelString: 'openai-codex:gpt-5.5',
      apiKey: '',
      baseUrl: undefined,
      providerType: undefined,
    });
  });

  it.each([
    [401, 'ChatGPT sign-in is required'],
    [403, 'This ChatGPT workspace does not have Codex access'],
    [429, 'ChatGPT plan quota or rate limit reached'],
  ] as const)(
    'preserves safe Codex status %i without leaking upstream details',
    async (status, message) => {
      const sentinel = `private-upstream-body-${status}`;
      mocks.callLLM.mockRejectedValueOnce(
        Object.assign(new Error(sentinel), { statusCode: status, cause: { body: sentinel } }),
      );

      const res = await postVerifyModel({ model: 'openai-codex:gpt-5.5' });
      const json = await res.json();

      expect(res.status).toBe(status);
      expect(json).toMatchObject({ success: false, error: message });
      expect(JSON.stringify(json)).not.toContain(sentinel);
      expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain(sentinel);
    },
  );

  it('sanitizes Codex resolution failures too', async () => {
    const sentinel = 'private-resolve-failure';
    mocks.resolveModel.mockRejectedValueOnce(
      Object.assign(new Error(sentinel), { statusCode: 403 }),
    );

    const res = await postVerifyModel({ model: 'openai-codex:gpt-5.5' });
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error).toBe('This ChatGPT workspace does not have Codex access');
    expect(JSON.stringify(json)).not.toContain(sentinel);
  });

  it.each(['CREDENTIALS_MISSING', 'SIGNED_OUT', 'INVALID_GRANT', 'REFRESH_REJECTED'])(
    'maps the safe Codex auth code %s to re-login',
    async (code) => {
      mocks.resolveModel.mockRejectedValueOnce(Object.assign(new Error('safe'), { code }));

      const res = await postVerifyModel({ model: 'openai-codex:gpt-5.5' });
      const json = await res.json();

      expect(res.status).toBe(401);
      expect(json.error).toBe('ChatGPT sign-in is required');
    },
  );
  function apiCallError(statusCode: number) {
    return new APICallError({
      message: 'internal-secret-body',
      url: 'http://10.0.0.5/v1/chat/completions',
      requestBodyValues: {},
      statusCode,
      responseBody: 'internal-secret-body',
    });
  }

  it.each([
    [401, 'API key is invalid or expired'],
    [403, 'API key is invalid or expired'],
    [404, 'Model not found or API endpoint error'],
    [429, 'API rate limit exceeded, please try again later'],
    [502, 'API request failed (HTTP 5xx)'],
    [418, 'API request failed (HTTP 4xx)'],
  ])('maps an upstream %i by status and never echoes the body', async (status, message) => {
    mocks.callLLM.mockRejectedValue(apiCallError(status));

    const res = await postVerifyModel({ model: 'openai:gpt-4o-mini', apiKey: 'k' });
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json).toEqual({ success: false, errorCode: 'INTERNAL_ERROR', error: message });
  });

  it.each([
    new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 10.0.0.5:80') }),
    new Error('getaddrinfo ENOTFOUND internal.test'),
    new SyntaxError('Unexpected token < in JSON at position 0: <html>internal-secret</html>'),
    Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
  ])('answers a transport or parse failure with one fixed message (%s)', async (error) => {
    mocks.callLLM.mockRejectedValue(error);

    const res = await postVerifyModel({ model: 'openai:gpt-4o-mini', apiKey: 'k' });

    expect(await res.json()).toEqual({
      success: false,
      errorCode: 'INTERNAL_ERROR',
      error: 'Cannot connect to API server, please check the Base URL',
    });
  });
});
