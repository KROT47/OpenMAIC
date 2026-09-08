import { describe, expect, it, vi } from 'vitest';
import type { Dispatcher } from 'undici';
import { createStrictFetchTransport, StrictFetchError } from '@/lib/server/strict-fetch';

const dispatcher = {} as Dispatcher;

describe('strict outbound transport', () => {
  it('rejects a public redirect to a private target before the second request', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: 'http://100.100.100.200/meta' } }),
    );
    const transport = createStrictFetchTransport({ dispatcher, fetchImpl });

    await expect(transport.fetch('https://public.example/start')).rejects.toBeInstanceOf(
      StrictFetchError,
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('pins every hop to one dispatcher and strips credentials across origins', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 307,
          headers: { location: 'https://cdn.example/final' },
        }),
      )
      .mockResolvedValueOnce(new Response('ok'));
    const transport = createStrictFetchTransport({ dispatcher, fetchImpl });

    const response = await transport.fetch('https://api.example/start', {
      headers: { authorization: 'Bearer secret', cookie: 'secret=1' },
    });
    expect(await response.text()).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ dispatcher, redirect: 'manual' });
    const redirectedHeaders = fetchImpl.mock.calls[1]![1]!.headers as Headers;
    expect(redirectedHeaders.has('authorization')).toBe(false);
    expect(redirectedHeaders.has('cookie')).toBe(false);
  });
});
