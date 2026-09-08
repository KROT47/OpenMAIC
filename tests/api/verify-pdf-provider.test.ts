import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  isServerConfiguredProvider: vi.fn(),
  resolveManagedAliDocMindCredentials: vi.fn(),
  resolvePDFApiKey: vi.fn(),
  resolvePDFBaseUrl: vi.fn(),
}));

vi.mock('@/lib/server/provider-config', () => ({
  isServerConfiguredProvider: mocks.isServerConfiguredProvider,
  resolveManagedAliDocMindCredentials: mocks.resolveManagedAliDocMindCredentials,
  resolvePDFApiKey: mocks.resolvePDFApiKey,
  resolvePDFBaseUrl: mocks.resolvePDFBaseUrl,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

async function postVerifyPdfProvider(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/verify-pdf-provider/route');
  const request = new Request('http://localhost/api/verify-pdf-provider', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(request as unknown as NextRequest);
}

describe('POST /api/verify-pdf-provider', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.isServerConfiguredProvider.mockReset();
    mocks.resolveManagedAliDocMindCredentials.mockReset();
    mocks.resolvePDFApiKey.mockReset();
    mocks.resolvePDFBaseUrl.mockReset();

    mocks.isServerConfiguredProvider.mockReturnValue(false);
    mocks.resolvePDFApiKey.mockImplementation(
      (_providerId: string, clientApiKey?: string) => clientApiKey,
    );
    mocks.resolvePDFBaseUrl.mockImplementation(
      (_providerId: string, clientBaseUrl?: string) => clientBaseUrl,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects a MinerU Cloud redirect after one request without reading its body', async () => {
    mocks.isServerConfiguredProvider.mockReturnValue(true);
    mocks.resolvePDFApiKey.mockReturnValue('server-key');
    mocks.resolvePDFBaseUrl.mockReturnValue('https://mineru.example.com');
    const text = vi.fn().mockResolvedValue('redirect response body');
    const fetchMock = vi.fn().mockResolvedValue({
      status: 302,
      text,
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const res = await postVerifyPdfProvider({
      providerId: 'mineru-cloud',
    });
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json).toEqual({
      success: false,
      errorCode: 'REDIRECT_NOT_ALLOWED',
      error: 'Redirects are not allowed',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mineru.example.com/extract-results/batch/test-connection',
      expect.objectContaining({ redirect: 'manual' }),
    );
    expect(text).not.toHaveBeenCalled();
  });

  it('preserves MinerU Cloud success responses', async () => {
    mocks.isServerConfiguredProvider.mockReturnValue(true);
    mocks.resolvePDFApiKey.mockReturnValue('server-key');
    mocks.resolvePDFBaseUrl.mockReturnValue('https://mineru.example.com/');
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const res = await postVerifyPdfProvider({
      providerId: 'mineru-cloud',
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      success: true,
      message: 'Connection successful',
      status: 200,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mineru.example.com/extract-results/batch/test-connection',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it.each([401, 403])('preserves MinerU Cloud authentication handling for %i', async (status) => {
    mocks.isServerConfiguredProvider.mockReturnValue(true);
    mocks.resolvePDFApiKey.mockReturnValue('server-key');
    mocks.resolvePDFBaseUrl.mockReturnValue('https://mineru.example.com');
    const text = vi.fn().mockResolvedValue('invalid token');
    const fetchMock = vi.fn().mockResolvedValue({
      status,
      statusText: 'Unauthorized',
      text,
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const res = await postVerifyPdfProvider({
      providerId: 'mineru-cloud',
    });
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json).toEqual({
      success: false,
      errorCode: 'INTERNAL_ERROR',
      error: 'Authentication failed: invalid token',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mineru.example.com/extract-results/batch/test-connection',
      expect.objectContaining({ redirect: 'manual' }),
    );
    expect(text).toHaveBeenCalledTimes(1);
  });

  it('rejects a client-supplied self-hosted base URL', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await postVerifyPdfProvider({
      providerId: 'mineru',
      baseUrl: 'https://mineru-self-hosted.example.com',
    });
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json).toEqual({
      success: false,
      errorCode: 'INVALID_URL',
      error: 'Custom PDF base URLs must be configured by the server operator',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
