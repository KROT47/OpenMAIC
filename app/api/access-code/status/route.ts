import { cookies } from 'next/headers';
import { apiSuccess } from '@/lib/server/api-response';
import { verifyAccessToken } from '@/lib/server/access-token';
import { getAccessCodeConfigurationError } from '@/lib/access-token-policy';

export async function GET() {
  const accessCode = process.env.ACCESS_CODE;
  const enabled = !!accessCode;
  const configurationError = accessCode ? getAccessCodeConfigurationError(accessCode) : undefined;
  const configurationValid = !configurationError;

  let authenticated = false;
  if (enabled && configurationValid) {
    const cookieStore = await cookies();
    const token = cookieStore.get('openmaic_access')?.value;
    authenticated = !!token && verifyAccessToken(token, accessCode);
  }

  return apiSuccess({
    enabled,
    authenticated,
    configurationValid,
    configurationError,
  });
}
