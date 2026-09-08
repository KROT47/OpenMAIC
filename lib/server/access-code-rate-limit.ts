import { createHash, createHmac } from 'node:crypto';
import { Pool } from 'pg';

const WINDOW_SECONDS = 60;
const SOURCE_ATTEMPTS = 5;
const GLOBAL_ATTEMPTS = 100;

interface Queryable {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Array<{ allowed: boolean; retry_after_seconds: number | string }> }>;
}

interface LimiterState {
  connectionString?: string;
  pool?: Pool;
  schema?: Promise<unknown>;
}

const STATE_KEY = Symbol.for('openmaic.access-code-rate-limit');
const globalState = globalThis as typeof globalThis & { [STATE_KEY]?: LimiterState };
const state = (globalState[STATE_KEY] ??= {});

function limiterPool(): Pool {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('DATABASE_URL is required');
  if (!state.pool || state.connectionString !== connectionString) {
    state.connectionString = connectionString;
    state.pool = new Pool({ connectionString, max: 2 });
    state.schema = undefined;
  }
  return state.pool;
}

async function ensureSchema(queryable: Queryable): Promise<void> {
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS access_code_attempt_windows (
      bucket_key text PRIMARY KEY,
      window_started_at timestamptz NOT NULL,
      attempts integer NOT NULL CHECK (attempts >= 0)
    )
  `);
}

function ensureSharedSchema(queryable: Queryable): Promise<unknown> {
  if (!state.schema) {
    state.schema = ensureSchema(queryable).catch((error) => {
      state.schema = undefined;
      throw error;
    });
  }
  return state.schema;
}

export function resolveAccessCodeRateLimitKeys(request: Request, accessCode: string) {
  const headerName = process.env.ACCESS_CODE_TRUSTED_IP_HEADER!.trim();
  const source = request.headers.get(headerName)?.trim();
  if (!source) throw new Error(`Trusted proxy did not provide ${headerName}`);
  const deployment = createHash('sha256').update(accessCode).digest('hex');
  const sourceHash = createHmac('sha256', accessCode).update(source).digest('hex');
  return {
    globalKey: `global:${deployment}`,
    sourceKey: `source:${sourceHash}`,
  };
}

/** Atomically consume shared global and per-source budgets in PostgreSQL. */
export async function takeAccessCodeAttempt(
  keys: { globalKey: string; sourceKey: string },
  queryable: Queryable = limiterPool(),
): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
  if (queryable === state.pool) await ensureSharedSchema(queryable);
  else await ensureSchema(queryable);

  const result = await queryable.query(
    `
      WITH current_time AS (
        SELECT clock_timestamp() AS now
      ), cleanup AS (
        DELETE FROM access_code_attempt_windows
        WHERE ctid IN (
          SELECT ctid
          FROM access_code_attempt_windows, current_time
          WHERE window_started_at < current_time.now - interval '1 hour'
          LIMIT 100
        )
      ), global_status AS (
        SELECT
          access_code_attempt_windows.window_started_at,
          COALESCE(
            access_code_attempt_windows.attempts >= $3
              AND access_code_attempt_windows.window_started_at > current_time.now - make_interval(secs => $5),
            false
          ) AS exhausted
        FROM current_time
        LEFT JOIN access_code_attempt_windows ON bucket_key = $1
      ), source_consumed AS (
        INSERT INTO access_code_attempt_windows (bucket_key, window_started_at, attempts)
        SELECT $2, current_time.now, 1
        FROM current_time CROSS JOIN global_status
        WHERE NOT global_status.exhausted
        ON CONFLICT (bucket_key) DO UPDATE SET
          window_started_at = CASE
            WHEN access_code_attempt_windows.window_started_at <= EXCLUDED.window_started_at - make_interval(secs => $5)
              THEN EXCLUDED.window_started_at
            ELSE access_code_attempt_windows.window_started_at
          END,
          attempts = CASE
            WHEN access_code_attempt_windows.window_started_at <= EXCLUDED.window_started_at - make_interval(secs => $5)
              THEN 1
            ELSE access_code_attempt_windows.attempts + 1
          END
        RETURNING bucket_key, window_started_at, attempts
      ), global_consumed AS (
        INSERT INTO access_code_attempt_windows (bucket_key, window_started_at, attempts)
        SELECT $1, current_time.now, 1
        FROM current_time CROSS JOIN source_consumed
        WHERE source_consumed.attempts <= $4
        ON CONFLICT (bucket_key) DO UPDATE SET
          window_started_at = CASE
            WHEN access_code_attempt_windows.window_started_at <= EXCLUDED.window_started_at - make_interval(secs => $5)
              THEN EXCLUDED.window_started_at
            ELSE access_code_attempt_windows.window_started_at
          END,
          attempts = CASE
            WHEN access_code_attempt_windows.window_started_at <= EXCLUDED.window_started_at - make_interval(secs => $5)
              THEN 1
            ELSE access_code_attempt_windows.attempts + 1
          END
        RETURNING bucket_key, window_started_at, attempts
      )
      SELECT
        NOT global_status.exhausted
          AND source_consumed.attempts <= $4
          AND COALESCE(global_consumed.attempts <= $3, true) AS allowed,
        ceil(greatest(
          CASE WHEN global_status.exhausted
            THEN extract(epoch FROM (global_status.window_started_at + make_interval(secs => $5) - current_time.now))
            ELSE 0 END,
          CASE WHEN source_consumed.attempts > $4
            THEN extract(epoch FROM (source_consumed.window_started_at + make_interval(secs => $5) - current_time.now))
            ELSE 0 END,
          CASE WHEN global_consumed.attempts > $3
            THEN extract(epoch FROM (global_consumed.window_started_at + make_interval(secs => $5) - current_time.now))
            ELSE 0 END
        ))::integer AS retry_after_seconds
      FROM current_time
      CROSS JOIN global_status
      LEFT JOIN source_consumed ON true
      LEFT JOIN global_consumed ON true
    `,
    [keys.globalKey, keys.sourceKey, GLOBAL_ATTEMPTS, SOURCE_ATTEMPTS, WINDOW_SECONDS],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Rate limiter returned no result');
  if (row.allowed) return { allowed: true };
  return { allowed: false, retryAfterSeconds: Math.max(1, Number(row.retry_after_seconds)) };
}
