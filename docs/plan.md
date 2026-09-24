# Zero + Foldkit + Effect — Plan

Goal: first-class support for the [Zero](https://zero.rocicorp.dev) sync engine in
Foldkit apps, an Effect-native server integration, and a faithful port of
[zbugs](https://github.com/rocicorp/mono/tree/latest/apps/zbugs) as the flagship
sample.

Versions pinned: `@rocicorp/zero@1.9.0`, `effect@4.0.0-rc.116` (foldkit's exact
peer dep; rc.117 exists but exact-peer matching keeps installs clean),
`foldkit@0.163.0`, `@foldkit/ui@0.163.0`.

---

## 1. How Zero fits together (what we're integrating)

Three runtime pieces per app:

- **Postgres** (upstream, `wal_level=logical`) — the source of truth.
- **zero-cache** (`npx zero-cache-dev` / self-hosted) — maintains a SQLite replica,
  syncs rows to clients, calls back into your API for query/mutate resolution.
- **Your app** — two halves:
  - *Client*: `new Zero({userID, auth, context, cacheURL, schema, mutators})`.
    Reads: `zero.materialize(query)` → `TypedView` with
    `addListener((data, resultType, error) => …)` / `view.destroy()` /
    `view.updateTTL(ttl)`; also `zero.run`, `zero.preload`.
    Writes: `zero.mutate(mutators.x(args))` → `{client, server}` promises.
    Status: `zero.connection.state.subscribe(…)` (connecting / connected /
    disconnected / error / needs-auth / closed).
  - *API server*: two HTTP endpoints that zero-cache calls:
    - `POST /api/query` → `handleQueryRequest({handler, schema, query, body,
      userID})` from `@rocicorp/zero/server` — resolves a named query (+args)
      into ZQL; this is where `ctx` (auth) is injected.
    - `POST /api/mutate` (push) → `handleMutateRequest({dbProvider, handler,
      query, body, userID})` — runs the matching server mutator inside a
      Postgres transaction via a `ZQLDatabase` (`dbProvider`).

Shared `schema.ts` / `queries.ts` / `mutators.ts` are used verbatim by both
sides — framework-agnostic TypeScript.

Framework bindings only wrap the client side. Official: React (`ZeroProvider`,
`useQuery`, `useZero`, `useSuspenseQuery`) and Solid (same shape +
`useConnectionState`). Community: zero-vue, zero-svelte(-query), zero-astro, One
(RN). Nobody has done Elm-style bindings — that's our gap and our
differentiator: Foldkit's Subscription/ManagedResource model maps onto Zero
*more* cleanly than hooks map onto React.

## 2. `zero-foldkit` — the client adapter

Zero's client API maps 1:1 onto Foldkit primitives (the foldkit `livestore`
example proves the shape — a store service feeding `Subscription.persistent`):

| Zero API | Foldkit primitive |
| --- | --- |
| `new Zero(opts)` + `zero.close()` | `ManagedResource` — `modelToMaybeRequirements` gates on session/`Option<ZeroOptions>`; `acquire` constructs, `release` calls `close()` |
| `zero.materialize(q)` + `addListener` | `Subscription` entry — `Stream.callback`/`Stream.unwrap` emits a `GotX({data, details})` Message per commit |
| `zero.mutate(mr)` | `Command` — `Effect.tryPromise`; `result.client` / `result.server` → `Completed*`/`Failed*` Messages |
| `zero.run(q)` / `zero.preload(q)` | `Command` helpers |
| `zero.connection.state.subscribe` | `Subscription` → `GotConnectionState` Message |

Draft API surface (package `zero-foldkit`):

```ts
// service identity — the Zero instance lives in a ManagedResource
export const ZeroClient = ManagedResource.tag<Zero<S, MD, C>>()('ZeroClient')

// entry factory used inside ManagedResource.make
export const zeroResource = <S, MD, C>() => ({
  resource: ZeroClient,
  modelToMaybeRequirements: model => /* Option<ZeroOptions> */,
  acquire: opts => Effect.sync(() => new Zero(opts)),
  release: zero => Effect.promise(() => zero.close()),
  onAcquired: zero => Message.ZeroReady(...),
  onReleased: () => Message.ZeroReleased(),
  onAcquireError: e => Message.ZeroFailed(...),
})

// useQuery-equivalent: Subscription entry.
// deps = { queryHash: Schema.String, request: <declared any> }
// keepAliveEquivalence keyed on queryHash → the view is re-materialized only
// when the *hash* changes; stable-hash query objects never restart the stream.
export const query = <TReturn>(
  config: {
    modelToRequest: (model) => QueryOrQueryRequest<...> | null | undefined
    toMessage: (data: HumanReadable<TReturn>, details: QueryResultDetails) => Message
    ttl?: TTL
  },
) => SubscriptionEntry

// mutate/run/preload as Commands, connection state as a Subscription
export const mutate = Command.define('ZeroMutate', { execute: ... })
export const runOnce = ...
export const connectionState = ...
```

Notes on the design:

- `QueryResultDetails` (`unknown | cached | complete | error`) rides along in
  the Message so the Model can distinguish optimistic vs server-confirmed data
  (zbugs' UI uses this for skeletons/"synced" badges).
- Falsy query support like `useQuery` (`null`/route-not-ready) via
  `Option`-typed dependency — stream becomes `Stream.empty`, emitting
  `ClearedX` or nothing.
- Immutable results are safe to store directly in the Model (Zero docs warn to
  treat them as immutable — matches Foldkit semantics).
- No custom `Output`/view implementation needed (unlike Solid's `SolidView`,
  which exists for fine-grained store updates). Foldkit re-renders through the
  vdom anyway — a plain `TypedView` listener → dispatch is the right grain.

## 3. `zero-effect` — is it needed?

**Verdict: Zero already works in a plain Effect app.** The two endpoints are
Request-in/JSON-out helpers; `zeroPostgresJS(schema, sql)` gives you the
`dbProvider`; nothing blocks you. A minimal Effect service is ~50 lines.

But a small library earns its keep — three real gaps:

1. **`@effect/sql` DB adapter.** Zero ships adapters for drizzle / kysely /
   prisma / pg / postgres.js — not `@effect/sql`. The `DBConnection` interface
   is tiny (`query(sql, params)`, `transaction(fn)` over `DBTransaction`
   exposing `wrappedTransaction` + `runQuery`). Wrapping `SqlClient`'s
   `withTransaction` so one Effect-managed pool serves both the app and Zero's
   push processor is the single most valuable thing in the package (~150 LOC).
   `zeroEffectSql(schema)` → `Effect<ZQLDatabase, never, SqlClient>`.
2. **HttpApi wiring.** `handleQueryRequest` / `handleMutateRequest` need
   `query` + `body` + auth → `ctx`. Ship an `HttpApiGroup` (or HttpRouter
   handlers) `ZeroApi` that: extracts request parts, runs the app's auth
   middleware to build `ctx`, resolves `mustGetQuery`/`mustGetMutator`, and
   maps failures to typed `Data.TaggedError`s + correct HTTP statuses
   (401/403 → `needs-auth` client transition — important for reconnect UX).
3. **Effect-idiomatic mutator authoring.** Server mutator fns are plain
   `async ({tx, ctx, args})`. A `defineMutatorEffect` helper lets users write
   `Effect.gen` bodies (accessing app services like Email/Notify via
   `Runtime.runPromise` with a provided `Context`) while keeping the
   client/server shared signature Zero requires.

So: not *required*, but it turns "hand-rolled integration per app" into a
reusable, typed path — worth keeping, small scope (~400–600 LOC).

## 4. Repo structure — recommendation

**One repo.** Layout:

```
zero-foldkit/                     # this repo becomes the monorepo
  packages/
    zero-foldkit/                 # client bindings (the product)
    zero-effect/                  # Effect server helpers
  apps/
    zbugs/                        # the sample: foldkit client + effect api
      shared/  server/  src/  db/  docker/
```

Why: the sample is the *integration test* for both packages — it exercises
zero-foldkit's client bindings and zero-effect's server helpers against the
same shared schema/mutators. rocicorp does exactly this (zbugs lives in
`mono/`). Splitting into three repos buys publish ceremony and version drift at
precisely the stage where both libs churn daily. Suggestion: use the
`zero-foldkit` repo as the monorepo and either rename it (e.g. `zero-kit`,
`zero-mono` — GitHub keeps redirects) or fold `packages/zero-effect` in and
archive the `zero-effect` repo. If the packages ever need independent release
cycles, extracting `zero-effect` later is cheap — it's small and standalone.

## 5. The sample — zbugs, ported faithfully

zbugs = a Linear-style issue tracker dogfooding Zero (bugs.rocicorp.dev).
~18k TS LOC: `shared/` ~1.5k (schema/queries/mutators/auth — framework-free),
`server/`+`api/` ~1.6k (Fastify: GitHub OAuth → JWT cookie, mutate/query
endpoints, notify/discord/email post-commit tasks, machine routes, S3 upload),
`src/` ~5.8k React (list page, issue page, comments, pickers, markdown, emoji),
`db/` (drizzle schema + migrations + seed), `docker/` (pg primary + replica).

Port mapping:

| zbugs (React/Fastify/drizzle) | zbugs-foldkit |
| --- | --- |
| `shared/*` | near-verbatim port; validators: `zod/mini` → **Effect Schema** via Standard-Schema interop (verify; fallback: keep zod for 1:1 parity) |
| `db/` drizzle-schema + migrations + seed | keep drizzle schema/migrations verbatim (drizzle is just SQL tooling here); seed scripts reuse `@faker-js/faker` |
| `docker/` pg primary+replica compose | verbatim |
| `api/index.ts` Fastify server | Effect `HttpApi`/`HttpRouter` on `@effect/platform-node` via `zero-effect`; JWT via `jose`; OAuth flow preserved; vite proxy `/api` → effect server (mirrors zbugs' vite-plugin-fastify approach, simpler) |
| `server/server-mutators.ts` post-commit tasks (notify/discord/email) | Effect services; integrations optional via env (same graceful no-op when unconfigured) |
| `src/` React app | foldkit: `defineRouteUnion` routes (`/`, `/p/:project`, `/p/:project/issue/:id`, `/issue/:id` redirect), `Runtime.RoutingApplicationInit`, pages as Submodels; UI via creaseui/`@foldkit/ui` + tailwind |
| `zero-init.tsx` `ZeroProvider` | `ManagedResource` acquire keyed on session Option |
| `useQuery` call sites | `Zero.query` subscription entries feeding `Got*` Messages |
| `z.mutate(...)` call sites | `Zero.mutate` Commands; `{client,server}` ack handling where zbugs uses it (e.g. delete→navigate) |
| `useConnectionState` | connection-state subscription → offline banner/read-only gating |

Phased delivery:

- **Phase 1 (this session):** monorepo scaffold; `zero-foldkit` core
  (resource + query sub + mutate/run/preload + connection state);
  `zero-effect` core (sql adapter + endpoint wiring + ctx middleware);
  `shared/` port; Effect API server; docker pg + migrations + seed; foldkit
  client vertical slice (login, list page reading real synced data, issue
  detail read view). Prove live sync end-to-end.
- **Phase 2:** write paths — create/edit/close/delete issues, comments, emoji
  reactions, labels, assignees; onboarding/login UX polish.
- **Phase 3:** parity — search, filter bar, kanban/list toggle, multi-select,
  markdown editor, image upload (S3 presigned), relative-time, tooltips,
  notification prefs, machine routes, perf tooling.

Effort in sessions: P1 ≈ 1, P2 ≈ 1, P3 ≈ 1–2 (external waits — OAuth app
setup, CI, publishing — are on your side).

## 6. Risks / open questions

- **Validator choice:** Zero needs Standard-Schema validators. Effect v4
  Schema supports the spec; I'll verify `Schema.standardSchemaV1` interop
  during the port, else keep `zod/mini` (what zbugs uses).
- **IDB in dev:** Zero persists to IndexedDB; model state mirrors synced data —
  fine, but hot-reload/auth changes should go through the resource's
  acquire/release rather than reconstructing Zero by hand.
- **`zero-cache` lifecycle:** `zero-cache-dev` must run alongside api+vite;
  document the three-process dev loop (and add a `pnpm dev` orchestrator).
- **npm names:** `zero-foldkit` / `zero-effect` may be taken on npm; use
  `@potti1234/*` or similar scope when publishing.
- **foldkit peer pin:** foldkit peers `effect@4.0.0-rc.116` exactly — pin
  rc.116 everywhere until foldkit widens the range.
