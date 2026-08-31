import { getModel } from '@/lib/ai/providers';
import { rebuildCodexModelInfo } from '@/lib/ai/codex-catalog';
import { bindCodexLanguageModelMetadata } from '@/lib/ai/codex-model';
import type {
  ServerModelAdapterParams,
  ServerModelAdapterResult,
} from '@/lib/server/providers/model-adapters';

import { getCodexOAuthAvailability } from './availability';
import {
  createEphemeralCodexLogicalSession,
  deriveCodexUpstreamSessionId,
} from './logical-session';
import { getCodexAuthRuntime } from './runtime';
import { createCodexResponsesTransport } from './transport';

export async function resolveCodexModel(
  params: ServerModelAdapterParams,
): Promise<ServerModelAdapterResult> {
  const availability = await getCodexOAuthAvailability();
  if (!availability.available) {
    throw new Error(`Codex OAuth provider is unavailable (${availability.reason})`);
  }

  const { tokenProvider, modelDiscovery } = getCodexAuthRuntime();
  const modelCapability = await modelDiscovery.getModelCapability(params.modelId);
  const discoveredModel = rebuildCodexModelInfo(modelCapability?.modelInfo);
  if (!discoveredModel) {
    throw new Error('Codex model is unavailable for the connected account');
  }

  const serviceTier =
    params.serviceTier === 'priority' &&
    discoveredModel.capabilities?.serviceTiers?.includes('priority')
      ? 'priority'
      : undefined;
  const transport = createCodexResponsesTransport({
    tokenProvider,
    capabilityLease: modelCapability!.capabilityLease,
    sessionId: deriveCodexUpstreamSessionId(
      params.logicalSession ?? createEphemeralCodexLogicalSession(),
    ),
  });
  const { model: unboundModel } = getModel({
    providerId: params.providerId,
    modelId: params.modelId,
    apiKey: '',
    customFetch: transport,
    ...(serviceTier ? { serviceTier } : {}),
  });

  return {
    model: bindCodexLanguageModelMetadata(unboundModel, discoveredModel),
    modelInfo: discoveredModel,
    apiKey: '',
    ...(serviceTier ? { serviceTier } : {}),
  };
}
