const NATIVE_CREDENTIAL_PROVIDER_IDS = new Set(['openai-codex']);

export function stripNativeCredentialProviders<T>(providers: Record<string, T>): Record<string, T> {
  for (const providerId of NATIVE_CREDENTIAL_PROVIDER_IDS) delete providers[providerId];
  return providers;
}
