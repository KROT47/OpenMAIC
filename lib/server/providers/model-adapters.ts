import type { ModelWithInfo } from '@/lib/ai/providers';
import type { ModelServiceTier, ProviderId } from '@/lib/types/provider';
import type { ModelLogicalSession } from '@/lib/server/model-logical-session';
import { resolveCodexModel } from '@/lib/server/codex/model-resolver';

export interface ServerModelAdapterParams {
  providerId: ProviderId;
  modelId: string;
  serviceTier?: ModelServiceTier;
  logicalSession?: ModelLogicalSession;
}

export interface ServerModelAdapterResult extends ModelWithInfo {
  apiKey: string;
  baseUrl?: string;
  serviceTier?: ModelServiceTier;
}

type ServerModelAdapter = (params: ServerModelAdapterParams) => Promise<ServerModelAdapterResult>;

const SERVER_MODEL_ADAPTERS: Record<string, ServerModelAdapter> = {
  'openai-codex': resolveCodexModel,
};

export async function resolveServerModelAdapter(
  params: ServerModelAdapterParams,
): Promise<ServerModelAdapterResult | undefined> {
  return SERVER_MODEL_ADAPTERS[params.providerId]?.(params);
}
