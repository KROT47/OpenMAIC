# ChatGPT/Codex subscription OAuth integration

## Provenance

- Official repository: `THU-MAIC/OpenMAIC`
- Integration base: `upstream/main` at `9d16e68296dbfdf6002e0572fef98ea3689fee29`
- Fork: `KROT47/OpenMAIC`
- Original fork main: `origin/main` at `9d16e68296dbfdf6002e0572fef98ea3689fee29`
- Community repository: `YizukiAme/SpiralMAIC`
- Community source branch: `codex-oauth-provider`
- Community branch tip inspected: `f6d1135d36740d260a5fc89fbd4e31a0aec0581e`

The integration selected the current feature commits by message, changed files, and behavior rather
than relying on historical SHAs from the upstream discussion:

| Community commit | Integrated commit | Component |
| --- | --- | --- |
| `42e8e468e2e834981512a04785b6677ecdea9056` | `b1c01483` | Server-side OAuth core |
| `d70c45de4fb2718a258bc32bbd3557ff0000782b` | `fcef2691` | Codex Responses provider and transport |
| `63699ded197a56d7034f2ef8b4579582efd9ff74` | `bf5607a9` | Auth APIs and dynamic model catalog |
| `2950d01d8f338e670bff28e7a0ab8e4a63618a4f` | `c6ecfa78` | Settings and account workflow |
| `79ca9b2e96feab9b498cebcde5d80c8b0b335013` | `ac8456ca` | Optional `gpt-image-2` generation |

The OAuth core and auth API/model-catalog commits applied cleanly. The Responses, Settings, and
image commits conflicted with OpenMAIC v1 architecture and were resolved manually.

## OpenMAIC v1 adaptations

Current OpenMAIC behavior was retained wherever the older community branch diverged:

- Codex remains a distinct `openai-codex` provider. It cannot be configured through generic
  API-key YAML/environment settings and never falls back to normal OpenAI Platform billing.
- Provider-specific model and image behavior sits behind v1 server adapter/composition roots;
  provider-neutral resolution and image routes contain no Codex-specific dispatch logic.
- Agent Workbench uses its current durable server-backed runtime. Its durable edit ID is passed as
  model-session identity without restoring the removed pre-v1 client agent runtime.
- Current stage routing, Bedrock policy, web search, thinking arbitration, service-tier headers,
  PBL v2 runtime, provider validation, and server-backed settings behavior were preserved.
- Current KV-backed settings persistence is retained. OAuth connection state, credentials, and the
  live account model catalog are distrusted during browser rehydration; the catalog is refreshed
  from the server.
- Dynamic discovery controls the selectable Codex models, reasoning metadata, and `priority`
  service tier. Fast mode is sent only when the discovered model advertises `priority` support.
- The current OpenMAIC `1.0.0` application identity is used on Codex requests; the separate Codex
  compatibility version used by model discovery remains unchanged.
- `gpt-image-2` uses the native Codex image transport only when the OAuth account is available.
  Existing API-key and local image providers retain their normal adapters and configuration.
- Files removed by OpenMAIC v1 (old editor agent runtime, edit API, and PBL v1 paths) were not
  restored. Unrelated old PBL and multi-tab locale entries from the community branch were removed.

No dependency was added or downgraded. The current `pnpm-lock.yaml` remains authoritative. The
community acceptance and force-refresh scripts use the already installed `tsx` runtime.

## Conflict and manual-port summary

The Responses conflict was resolved around current provider construction, stage/model resolution,
thinking replay, session history, and streaming. The Settings conflict was resolved around the
access-code unlock flow, KV persistence, provider recovery, PBL v2 callers, and current locale
files. The image conflict was resolved around current server-disabled/provider-default behavior,
the existing image adapters, settings usability, and media persistence.

The compatibility port added or manually adapted these boundaries:

- `lib/server/providers/model-adapters.ts`
- `lib/server/codex/model-resolver.ts`
- `lib/server/model-logical-session.ts`
- `lib/server/resolve-model.ts`
- `lib/server/agent-runtime/agent-driver-model.ts`
- `lib/server/agent-runtime/runner.ts`
- `lib/server/providers/image-route-adapters.ts`
- `lib/server/codex/image-route-adapter.ts`
- `app/api/generate/image/route.ts`
- `app/api/verify-image-provider/route.ts`
- `lib/server/providers/server-config-policy.ts`
- `lib/server/provider-config.ts`
- all twelve current locale files under `lib/i18n/locales/`
- focused model, image-route, settings-persistence, media, Workbench, and Codex Settings browser
  tests

## Requirements and environment

Use Node.js `>=20.9.0` and the repository-pinned pnpm version. Install and start normally:

```bash
pnpm install
pnpm dev
```

No Codex-specific environment variable and no `OPENAI_API_KEY` are required for ChatGPT/Codex
subscription authentication. `OPENAI_API_KEY` remains an independent optional setting for the
normal `openai` provider.

Production use requires a generated, high-entropy `ACCESS_CODE`. Follow the
[README ACCESS_CODE setup](README.md#optional-access_code-shared-deployments), including the
database and trusted proxy header configuration; human-selected and legacy codes are rejected.

Do not put fake values in `.env.local`. On Docker, mount `/app/data` persistently and run a single
application replica. The native provider intentionally reports unavailable on Vercel, Netlify,
AWS Lambda, Cloudflare Pages, Cloud Run/function-style environments, or when production lacks
`ACCESS_CODE`.

## Credential and model-cache storage

The default data root is `<OpenMAIC checkout>/data` (or `/app/data` in the container):

- Credentials: `data/auth/openai-codex.json`
- Last-known-good model catalog: `data/cache/openai-codex-models.v1.json`
- Runtime coordination: private entries below `data/auth/`

The data directory is gitignored. Credentials stay on the Node server and are never returned to
the browser or written to localStorage. The implementation serializes credential mutations,
rotates refresh tokens, clears invalid-grant credentials, and coordinates login/logout/refresh
races. Credential directories are restricted to mode `0700`, files to `0600`, reads reject
symlinks and inode swaps, and writes use exclusive temporary files, `fsync`, and atomic rename.
Only one live Node process may own a given Codex auth directory.

Never log or copy `data/auth/openai-codex.json`. It contains bearer and refresh tokens.

## Browser PKCE sign-in

1. Start OpenMAIC and open **Settings**.
2. Open **LLM**, then select **Codex**.
3. Press **Sign in with ChatGPT**.
4. Complete the OpenAI authorization page in the popup.
5. OpenAI redirects the browser to `http://localhost:1455/auth/callback`. OpenMAIC validates the
   OAuth state and PKCE verifier before storing credentials.
6. Success is shown as **Connected with ChatGPT** (or the account email), followed by the account's
   discovered Codex model list.

Port `1455` must be free on the machine running the browser callback. If the browser is not on the
same machine as the OpenMAIC process, use device-code sign-in instead.

## Device-code sign-in

1. In **Settings → LLM → Codex**, press **Use device code**.
2. Open the displayed verification link, currently `https://auth.openai.com/codex/device`.
3. Enter the one-time code shown by OpenMAIC and approve access.
4. Leave the Settings page open while OpenMAIC polls. Success changes the account card to
   **Connected with ChatGPT** and refreshes the model catalog.

Use **Cancel sign-in** to stop a pending attempt and **Sign out** to revoke/clear the local session.
The UI never asks for or displays a refresh token.

## Models, reasoning, Fast mode, and images

After authentication, `/api/server-providers` fetches the account-scoped Codex catalog from the
ChatGPT/Codex backend and publishes only the safe OpenMAIC model DTO. Model IDs, availability,
context/output limits, vision/tools/streaming flags, reasoning effort values, and service tiers are
rebuilt from an allowlisted schema.

Reasoning controls are enabled only when the discovered model declares them. Fast mode maps to the
`priority` service tier and is visible/sent only for models whose catalog advertises that tier.
Routed server stages do not inherit a client Fast request.

The `codex-image` provider is separate from `openai-image`. It fixes the subscription-backed model
to `gpt-image-2`, ignores client API-key/base-URL overrides, and is published only while Codex OAuth
credentials are usable. Availability still depends on the ChatGPT workspace entitlement; a 403 is
reported safely without changing normal image-provider behavior.

## Validation and diagnostics

Useful checks are:

```bash
pnpm exec tsc --noEmit
pnpm lint
pnpm check
pnpm test
pnpm build
```

The offline unit/integration suites do not require a ChatGPT account. `pnpm accept:codex` is an
account-backed acceptance harness; do not run it until the operator has intentionally signed in.
`pnpm refresh:codex` is an offline force-refresh diagnostic for the local credential vault.

## Known limitations

- This is an experimental community integration, not an official OpenMAIC or OpenAI billing path.
- It supports one user, one Node process, and one persistent data directory. Multi-user or
  multi-replica deployment is intentionally unavailable.
- Serverless deployments are unsupported because OAuth credentials and coordination state require
  persistent local storage.
- Browser PKCE requires the local callback on port `1455`; headless/remote deployments should use
  device flow.
- Live model and image entitlement can only be confirmed after signing in with a real ChatGPT
  account. `gpt-image-2` may be absent or forbidden for some workspaces.

## Updating from upstream

Keep the remote topology:

```text
origin/main                    KROT47 stable main
upstream/main                  THU-MAIC official main
feat/codex-oauth-provider      maintained integration branch
community/codex-oauth-provider community source
```

Update without rewriting published history:

```bash
git fetch origin
git fetch upstream
git fetch community codex-oauth-provider
git switch feat/codex-oauth-provider
git merge upstream/main
pnpm install
pnpm exec tsc --noEmit
pnpm lint
pnpm test
pnpm build
git push origin feat/codex-oauth-provider
```

Resolve conflicts with current OpenMAIC architecture as authoritative, especially in provider
adapters, server model resolution, Settings persistence, Agent Workbench, generation packages, and
image routes. Do not re-cherry-pick the five commits above. If the community branch gains new work,
identify only the new functional commits by history and changed files, then port them separately.
Update `origin/main` from `upstream/main` as a separate fork-maintenance decision; do not merge this
feature branch into `main` implicitly.
