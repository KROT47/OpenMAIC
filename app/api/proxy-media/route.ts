/**
 * Media Proxy API
 *
 * Server-side proxy for fetching remote media URLs (images/videos).
 * Required because browser fetch() to remote CDN URLs fails with CORS errors.
 * The media orchestrator uses this to download generated media as blobs
 * for IndexedDB persistence.
 *
 * POST /api/proxy-media
 * Body: { url: string }
 * Response: Binary blob with appropriate Content-Type
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { apiError } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
import { createStrictFetchTransport, StrictFetchError } from '@/lib/server/strict-fetch';

const log = createLogger('ProxyMedia');

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  let url: string | undefined;
  let transport: ReturnType<typeof createStrictFetchTransport> | undefined;
  try {
    ({ url } = await request.json());

    if (!url || typeof url !== 'string') {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing or invalid url');
    }

    // Initial SSRF validation
    const ssrfError = await validateUrlForSSRF(url);
    if (ssrfError) {
      return apiError('INVALID_URL', 403, ssrfError);
    }

    transport = createStrictFetchTransport();
    const response = await transport.fetch(url);

    if (!response.ok) {
      // Forward client (4xx) errors as-is so the caller treats them as permanent
      // (no retry); collapse upstream server (5xx) errors to 502.
      const status = response.status >= 400 && response.status < 500 ? response.status : 502;
      await response.body?.cancel().catch(() => undefined);
      return apiError('UPSTREAM_ERROR', status, `Upstream returned ${response.status}`);
    }

    const MAX_PROXY_BYTES = 25 * 1024 * 1024; // 25 MiB
    const contentLength = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(contentLength) && contentLength > MAX_PROXY_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      return apiError('UPSTREAM_ERROR', 502, `Upstream asset too large (${contentLength} bytes)`);
    }
    const blob = await response.blob();
    if (blob.size > MAX_PROXY_BYTES) {
      return apiError('UPSTREAM_ERROR', 502, `Upstream asset too large (${blob.size} bytes)`);
    }
    const contentType = response.headers.get('content-type') || 'application/octet-stream';

    return new NextResponse(blob, {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(blob.size),
        'Cache-Control': 'private, max-age=3600',
      },
    });
  } catch (error) {
    if (error instanceof StrictFetchError) {
      if (error.code === 'invalid-url') return apiError('INVALID_URL', 403, error.message);
      if (error.code === 'too-many-redirects') {
        return apiError('TOO_MANY_REDIRECTS', 502, error.message);
      }
      return apiError('UPSTREAM_ERROR', 502, error.message);
    }
    log.error(`Proxy media failed [url="${url?.substring(0, 100) ?? 'unknown'}"]:`, error);
    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : String(error));
  } finally {
    await transport?.close().catch(() => undefined);
  }
}
