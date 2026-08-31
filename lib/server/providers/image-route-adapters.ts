import type { NextRequest } from 'next/server';
import type { ImageGenerationOptions } from '@/lib/media/types';
import { codexImageRouteAdapter } from '@/lib/server/codex/image-route-adapter';

export interface ServerImageRouteAdapter {
  generate(
    request: NextRequest,
    body: ImageGenerationOptions,
    clientModel: string | undefined,
  ): Promise<Response>;
  verify(): Promise<Response>;
}

const SERVER_IMAGE_ROUTE_ADAPTERS: Record<string, ServerImageRouteAdapter> = {
  'codex-image': codexImageRouteAdapter,
};

export function getServerImageRouteAdapter(
  providerId: string,
): ServerImageRouteAdapter | undefined {
  return SERVER_IMAGE_ROUTE_ADAPTERS[providerId];
}
