import { cookies } from 'next/headers';
import { timingSafeEqual } from 'crypto';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { createAccessToken } from '@/lib/server/access-token';
import {
  ACCESS_TOKEN_MAX_AGE_SECONDS,
  getAccessCodeConfigurationError,
} from '@/lib/access-token-policy';
import {
  resolveAccessCodeRateLimitKeys,
  takeAccessCodeAttempt,
} from '@/lib/server/access-code-rate-limit';

export async function POST(request: Request) {
  const accessCode = process.env.ACCESS_CODE;
  if (!accessCode) {
    return apiSuccess({ valid: true });
  }
  const configurationError = getAccessCodeConfigurationError(accessCode);
  if (configurationError) {
    return apiError('INVALID_CONFIGURATION', 503, configurationError);
  }

  let attempt;
  try {
    attempt = await takeAccessCodeAttempt(resolveAccessCodeRateLimitKeys(request, accessCode));
  } catch {
    return apiError('INTERNAL_ERROR', 503, 'Access-code verification is unavailable');
  }
  if (!attempt.allowed) {
    const response = apiError('RATE_LIMITED', 429, 'Too many access-code attempts');
    response.headers.set('Retry-After', String(attempt.retryAfterSeconds));
    return response;
  }

  let body: { code?: string };
  try {
    body = await request.json();
  } catch {
    return apiError('INVALID_REQUEST', 400, 'Invalid JSON body');
  }

  // Constant-time comparison
  if (!body.code) {
    return apiError('INVALID_REQUEST', 401, 'Invalid access code');
  }
  const encoder = new TextEncoder();
  const a = encoder.encode(body.code);
  const b = encoder.encode(accessCode);
  if (a.byteLength !== b.byteLength || !timingSafeEqual(a, b)) {
    return apiError('INVALID_REQUEST', 401, 'Invalid access code');
  }

  const token = createAccessToken(accessCode);
  const cookieStore = await cookies();
  cookieStore.set('openmaic_access', token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: ACCESS_TOKEN_MAX_AGE_SECONDS,
    secure: process.env.NODE_ENV === 'production',
  });

  return apiSuccess({ valid: true });
}
