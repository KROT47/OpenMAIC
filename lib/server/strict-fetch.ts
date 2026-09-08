import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { Agent, type Dispatcher } from 'undici';
import { assertSafeIp, normalizeUrlForStrictFetch } from '@/lib/server/ssrf-guard';

const MAX_REDIRECTS = 5;

export type StrictFetchImplementation = (
  input: string | URL,
  init?: RequestInit & { dispatcher?: Dispatcher },
) => Promise<Response>;

export class StrictFetchError extends Error {
  override readonly name = 'StrictFetchError';
  constructor(
    readonly code: 'invalid-url' | 'redirect' | 'too-many-redirects',
    message: string,
  ) {
    super(message);
  }
}

/** Reject the whole DNS answer set if any candidate could reach a non-public network. */
export function assertSafeLookupAddresses(addresses: LookupAddress[]): void {
  if (addresses.length === 0) throw new Error('DNS returned no addresses');
  for (const answer of addresses) assertSafeIp(answer.address);
}

function lookupAllThenPin(
  hostname: string,
  options: Record<string, unknown>,
  callback: (...args: unknown[]) => void,
): void {
  dnsLookup(
    hostname,
    { ...options, all: true, verbatim: true },
    (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => {
      if (error) return callback(error);
      try {
        assertSafeLookupAddresses(addresses);
      } catch (lookupError) {
        return callback(lookupError);
      }
      if (options.all === true) return callback(null, addresses);
      const first = addresses[0]!;
      callback(null, first.address, first.family);
    },
  );
}

/** Pin connection-time DNS to the exact answer set that passed IP classification. */
export function createPinnedFetchAgent(allowLocalNetworks = false): Agent {
  return new Agent({
    headersTimeout: 10_000,
    bodyTimeout: 30_000,
    connect: {
      timeout: 5_000,
      ...(allowLocalNetworks ? {} : { lookup: lookupAllThenPin as never }),
    },
  });
}

function redirectMethod(status: number, method: string): string {
  return status === 303 || ((status === 301 || status === 302) && method === 'POST')
    ? 'GET'
    : method;
}

/** One lifecycle-scoped, pinned transport with manual validation of every redirect hop. */
export function createStrictFetchTransport(
  options: {
    allowLocalNetworks?: boolean;
    fetchImpl?: StrictFetchImplementation;
    dispatcher?: Dispatcher;
  } = {},
) {
  const allowLocalNetworks = options.allowLocalNetworks === true;
  const ownedAgent = options.dispatcher ? null : createPinnedFetchAgent(allowLocalNetworks);
  const dispatcher = options.dispatcher ?? ownedAgent!;
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as StrictFetchImplementation);

  return {
    async fetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
      let current: URL;
      try {
        current = normalizeUrlForStrictFetch(String(input), {
          allowLocalNetworks,
          allowNonStandardPorts: true,
        });
      } catch (error) {
        throw new StrictFetchError(
          'invalid-url',
          error instanceof Error ? error.message : String(error),
        );
      }
      let method = (init.method ?? 'GET').toUpperCase();
      let body = init.body;
      const headers = new Headers(init.headers);
      for (let redirects = 0; ; redirects += 1) {
        const response = await fetchImpl(current, {
          ...init,
          method,
          body,
          headers,
          redirect: 'manual',
          dispatcher,
        });
        if (response.status < 300 || response.status >= 400) return response;
        if (redirects >= MAX_REDIRECTS) {
          await response.body?.cancel().catch(() => undefined);
          throw new StrictFetchError('too-many-redirects', 'Too many redirects');
        }
        const location = response.headers.get('location');
        if (!location) {
          await response.body?.cancel().catch(() => undefined);
          throw new StrictFetchError('redirect', 'Redirect response without Location header');
        }
        let next: URL;
        try {
          next = normalizeUrlForStrictFetch(new URL(location, current).href, {
            allowLocalNetworks,
            allowNonStandardPorts: true,
          });
        } catch (error) {
          await response.body?.cancel().catch(() => undefined);
          throw new StrictFetchError(
            'invalid-url',
            error instanceof Error ? error.message : String(error),
          );
        }
        await response.body?.cancel().catch(() => undefined);
        if (next.origin !== current.origin) {
          headers.delete('authorization');
          headers.delete('cookie');
          headers.delete('proxy-authorization');
        }
        const nextMethod = redirectMethod(response.status, method);
        if (nextMethod === 'GET' && method !== 'GET') {
          body = undefined;
          headers.delete('content-type');
          headers.delete('content-length');
        }
        method = nextMethod;
        current = next;
      }
    },
    close: () => ownedAgent?.close() ?? Promise.resolve(),
  };
}
