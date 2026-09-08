import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resolveAccessCodeRateLimitKeys,
  takeAccessCodeAttempt,
} from '@/lib/server/access-code-rate-limit';

const ACCESS_CODE = 'omc_jmZ633OgDh2O7NZel4OUjqYO-hDTNmKWYXBUQvbsI1I';

afterEach(() => {
  delete process.env.ACCESS_CODE_TRUSTED_IP_HEADER;
});

describe('shared access-code rate limit', () => {
  it('derives opaque deployment and source buckets from a trusted proxy header', () => {
    process.env.ACCESS_CODE_TRUSTED_IP_HEADER = 'x-real-ip';
    const request = new Request('https://openmaic.example/api/access-code/verify', {
      headers: { 'x-real-ip': '203.0.113.42' },
    });

    const keys = resolveAccessCodeRateLimitKeys(request, ACCESS_CODE);

    expect(keys.globalKey).toMatch(/^global:[a-f0-9]{64}$/);
    expect(keys.sourceKey).toMatch(/^source:[a-f0-9]{64}$/);
    expect(JSON.stringify(keys)).not.toContain('203.0.113.42');
  });

  it('atomically consumes both PostgreSQL buckets and returns their retry window', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ allowed: false, retry_after_seconds: '29' }] });

    await expect(
      takeAccessCodeAttempt(
        { globalKey: 'global:deployment', sourceKey: 'source:client' },
        { query },
      ),
    ).resolves.toEqual({ allowed: false, retryAfterSeconds: 29 });

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[0]).toContain('ON CONFLICT (bucket_key) DO UPDATE');
    expect(query.mock.calls[1]?.[0]).toContain('WHERE NOT global_status.exhausted');
    expect(query.mock.calls[1]?.[0]).toContain('WHERE source_consumed.attempts <= $4');
    expect(query.mock.calls[1]?.[0]).toContain(
      "window_started_at < current_time.now - interval '1 hour'",
    );
    expect(query.mock.calls[1]?.[1]).toEqual(['global:deployment', 'source:client', 100, 5, 60]);
  });
});
