export const ACCESS_TOKEN_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
export const ACCESS_TOKEN_CLOCK_SKEW_MS = 60_000;
export const ACCESS_CODE_CONFIGURATION_MESSAGE =
  'ACCESS_CODE must be generated as omc_ followed by 43 base64url characters';

/** 32 random bytes encoded as unpadded base64url, with an explicit product prefix. */
export function isAccessCodeSecurelyGenerated(accessCode: string): boolean {
  return /^omc_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(accessCode);
}

export function getAccessCodeConfigurationError(
  accessCode: string,
  env: { DATABASE_URL?: string; ACCESS_CODE_TRUSTED_IP_HEADER?: string } = process.env as {
    DATABASE_URL?: string;
    ACCESS_CODE_TRUSTED_IP_HEADER?: string;
  },
): string | undefined {
  if (!isAccessCodeSecurelyGenerated(accessCode)) return ACCESS_CODE_CONFIGURATION_MESSAGE;
  if (!env.DATABASE_URL?.trim()) {
    return 'ACCESS_CODE requires DATABASE_URL for shared attempt throttling';
  }
  const header = env.ACCESS_CODE_TRUSTED_IP_HEADER?.trim();
  if (!header || !/^[A-Za-z0-9-]+$/.test(header)) {
    return 'ACCESS_CODE requires ACCESS_CODE_TRUSTED_IP_HEADER from a trusted reverse proxy';
  }
  return undefined;
}

/** Shared Node/Edge timestamp policy for signed access-code cookies. */
export function isAccessTokenTimestampValid(timestamp: string, now = Date.now()): boolean {
  if (!/^(0|[1-9]\d*)$/.test(timestamp)) return false;
  const issuedAt = Number(timestamp);
  return (
    Number.isSafeInteger(issuedAt) &&
    issuedAt <= now + ACCESS_TOKEN_CLOCK_SKEW_MS &&
    now - issuedAt <= ACCESS_TOKEN_MAX_AGE_SECONDS * 1000
  );
}
