import type { NextRequest } from 'next/server';
import type { ImageGenerationOptions } from '@/lib/media/types';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { recordGenerationUsage } from '@/lib/server/usage-storage';
import type { ServerImageRouteAdapter } from '@/lib/server/providers/image-route-adapters';

import { getCodexOAuthAvailability } from './availability';
import {
  CODEX_IMAGE_GENERATIONS_ENDPOINT,
  CODEX_IMAGE_MODEL,
  CODEX_IMAGE_TRANSPORT_ERROR_CODES,
  CodexImageTransportError,
  createCodexImageTransport,
} from './image-transport';
import { getCodexAuthRuntime } from './runtime';
import {
  CODEX_OAUTH_ERROR_CODES,
  CodexOAuthError,
  type CodexOAuthErrorCode,
} from './token-provider';

const log = createLogger('CodexImageRouteAdapter');

function errorResponse(caught: unknown): Response {
  if (!(caught instanceof CodexImageTransportError)) {
    log.error('Unexpected local Codex image generation failure');
    return apiError('INTERNAL_ERROR', 500, 'Codex image generation failed unexpectedly');
  }

  const withSafeDiagnostics = (response: Response): Response => {
    if (caught.source) {
      response.headers.set('x-openmaic-codex-image-error-source', caught.source);
    }
    if (
      caught.source === 'upstream-http' &&
      Number.isInteger(caught.upstreamStatus) &&
      (caught.upstreamStatus as number) >= 100 &&
      (caught.upstreamStatus as number) <= 599
    ) {
      response.headers.set('x-openmaic-codex-image-upstream-status', String(caught.upstreamStatus));
    }
    return response;
  };

  switch (caught.code) {
    case CODEX_IMAGE_TRANSPORT_ERROR_CODES.AUTH_REQUIRED:
    case CODEX_IMAGE_TRANSPORT_ERROR_CODES.STALE_CREDENTIALS:
      return withSafeDiagnostics(
        apiError('INVALID_CREDENTIALS', 401, 'Reconnect Codex to generate images'),
      );
    case CODEX_IMAGE_TRANSPORT_ERROR_CODES.IMAGE_ENTITLEMENT_UNAVAILABLE:
      return withSafeDiagnostics(
        apiError(
          'PROVIDER_DISABLED',
          403,
          'This ChatGPT workspace does not have Codex image access',
        ),
      );
    case CODEX_IMAGE_TRANSPORT_ERROR_CODES.FORBIDDEN:
      return withSafeDiagnostics(
        apiError('UPSTREAM_ERROR', 403, 'The Codex image request was forbidden'),
      );
    case CODEX_IMAGE_TRANSPORT_ERROR_CODES.RATE_LIMITED:
      return withSafeDiagnostics(
        apiError('RATE_LIMITED', 429, 'The ChatGPT plan or Codex image rate limit was reached'),
      );
    case CODEX_IMAGE_TRANSPORT_ERROR_CODES.MODERATION_BLOCKED:
      return withSafeDiagnostics(
        apiError('CONTENT_SENSITIVE', 400, 'The image request was blocked by content moderation'),
      );
    case CODEX_IMAGE_TRANSPORT_ERROR_CODES.INVALID_REQUEST:
    case CODEX_IMAGE_TRANSPORT_ERROR_CODES.REQUEST_REJECTED:
      return withSafeDiagnostics(
        apiError('INVALID_REQUEST', 400, 'The Codex image request was rejected'),
      );
    case CODEX_IMAGE_TRANSPORT_ERROR_CODES.ROUTE_UNAVAILABLE:
      return withSafeDiagnostics(
        apiError(
          'UPSTREAM_ERROR',
          caught.upstreamStatus === 405 ? 405 : 404,
          'Codex image generation is unavailable on this backend',
        ),
      );
    case CODEX_IMAGE_TRANSPORT_ERROR_CODES.UPSTREAM_UNAVAILABLE:
    case CODEX_IMAGE_TRANSPORT_ERROR_CODES.NETWORK_ERROR:
    case CODEX_IMAGE_TRANSPORT_ERROR_CODES.INVALID_RESPONSE:
      return withSafeDiagnostics(
        apiError('UPSTREAM_ERROR', 502, 'Codex image generation is temporarily unavailable'),
      );
    case CODEX_IMAGE_TRANSPORT_ERROR_CODES.LOCAL_UNAVAILABLE:
      return apiError('PROVIDER_DISABLED', 503, 'Codex credentials are temporarily unavailable');
    case CODEX_IMAGE_TRANSPORT_ERROR_CODES.TIMEOUT:
      return withSafeDiagnostics(
        apiError('UPSTREAM_ERROR', 504, 'Codex image generation timed out'),
      );
    case CODEX_IMAGE_TRANSPORT_ERROR_CODES.INVALID_ENDPOINT:
    default:
      log.error(`Unexpected local Codex image transport category: ${caught.code}`);
      return apiError('INTERNAL_ERROR', 500, 'Codex image generation failed unexpectedly');
  }
}

async function generate(
  request: NextRequest,
  body: ImageGenerationOptions,
  clientModel: string | undefined,
): Promise<Response> {
  if (clientModel && clientModel !== CODEX_IMAGE_MODEL) {
    return apiError('INVALID_REQUEST', 400, `Codex image model must be ${CODEX_IMAGE_MODEL}`);
  }

  try {
    const availability = await getCodexOAuthAvailability();
    if (!availability.available) {
      return apiError('PROVIDER_DISABLED', 503, 'Codex OAuth image generation is unavailable');
    }
    const runtime = getCodexAuthRuntime();
    const transport = createCodexImageTransport({
      tokenProvider: runtime.tokenProvider,
      onObservation: (observation) => {
        log.info('Codex image success observation', observation);
      },
    });
    const result = await transport(CODEX_IMAGE_GENERATIONS_ENDPOINT, {
      prompt: body.prompt,
      aspectRatio: body.aspectRatio,
      signal: request.signal,
    });

    void recordGenerationUsage({
      kind: 'image',
      unit: 'image',
      providerId: 'codex-image',
      modelId: CODEX_IMAGE_MODEL,
      quantity: 1,
    });
    return apiSuccess({ result });
  } catch (caught) {
    return errorResponse(caught);
  }
}

const REAUTH_ERROR_CODES = new Set<CodexOAuthErrorCode>([
  CODEX_OAUTH_ERROR_CODES.CREDENTIALS_MISSING,
  CODEX_OAUTH_ERROR_CODES.SIGNED_OUT,
  CODEX_OAUTH_ERROR_CODES.INVALID_GRANT,
  CODEX_OAUTH_ERROR_CODES.REFRESH_REJECTED,
]);

function requiresReauthentication(error: unknown): boolean {
  return error instanceof CodexOAuthError && REAUTH_ERROR_CODES.has(error.code);
}

async function verify(): Promise<Response> {
  try {
    const availability = await getCodexOAuthAvailability();
    if (!availability.available) {
      return apiError('PROVIDER_DISABLED', 503, 'Codex OAuth image generation is unavailable');
    }
  } catch {
    return apiError('PROVIDER_DISABLED', 503, 'Codex OAuth image generation is unavailable');
  }

  try {
    await getCodexAuthRuntime().tokenProvider.getValidCredentials();
    return apiSuccess({ message: 'Codex OAuth connection is ready' });
  } catch (error) {
    return requiresReauthentication(error)
      ? apiError('INVALID_CREDENTIALS', 401, 'Reconnect Codex to generate images')
      : apiError('PROVIDER_DISABLED', 503, 'Codex OAuth connection could not be verified');
  }
}

export const codexImageRouteAdapter: ServerImageRouteAdapter = { generate, verify };
