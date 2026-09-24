import {
  Effect,
  Option,
  Queue,
  Schedule,
  Schema,
  Scope,
  Stream,
} from 'effect'
import { ManagedResource, Subscription } from 'foldkit'
import {
  asQueryInternals,
  type Immutable,
} from '@rocicorp/zero/bindings'
import {
  Zero,
  type BaseDefaultContext,
  type BaseDefaultSchema,
  type ConnectionState,
  type CustomMutatorDefs,
  type ErroredQuery,
  type HumanReadable,
  type MutateRequest,
  type MutatorResultDetails,
  type QueryOrQueryRequest,
  type QueryResultDetails,
  type ResultType,
  type RunOptions,
  type TTL,
  type TypedView,
  type ZeroOptions,
} from '@rocicorp/zero'

const clearedDetails: QueryResultDetails = { type: 'unknown' }

/**
 * The `entry` builders the runtime passes into `ManagedResource.make` /
 * `Subscription.make` are not public types — redeclaring the signatures the
 * helpers below call, so callbacks keep their inference.
 */
type ManagedResourceEntryBuilder<Model, Message> = <
  Requirements,
  Value,
  Service,
>(
  schema: Schema.Schema<Requirements>,
  config: {
    readonly resource: ManagedResource.ManagedResource<Value, Service>
    readonly modelToMaybeRequirements: (model: Model) => Requirements
    readonly acquire: (
      params: unknown,
    ) => Effect.Effect<Value, unknown, Scope.Scope>
    readonly release: (value: Value) => Effect.Effect<void>
    readonly onAcquired: (value: Value) => Message
    readonly onReleased: () => Message
    readonly onAcquireError: (error: unknown) => Message
  },
) => ManagedResource.Entry<Model, Message, Requirements, Value, Service>

type SubscriptionDependenciesSchema<Dependencies> = Schema.Schema<
  Dependencies
> & { readonly fields: Schema.Struct.Fields }

type SubscriptionEntry<Model, Message, Dependencies, Services> = {
  readonly dependenciesSchema: SubscriptionDependenciesSchema<Dependencies>
  readonly modelToDependencies: (model: Model) => Dependencies
  readonly keepAliveEquivalence: (a: Dependencies, b: Dependencies) => boolean
  readonly dependenciesToStream: (
    dependencies: Dependencies,
    readDependencies: () => Dependencies,
  ) => Stream.Stream<Message, never, Services>
}

type SubscriptionEntryBuilder<Model, Message, Services> = <
  const Fields extends Schema.Struct.Fields,
>(
  fields: Fields,
  callbacks: {
    readonly modelToDependencies: (
      model: Model,
    ) => Schema.Struct.Type<Fields>
    readonly keepAliveEquivalence: (
      a: Schema.Struct.Type<Fields>,
      b: Schema.Struct.Type<Fields>,
    ) => boolean
    readonly dependenciesToStream: (
      dependencies: Schema.Struct.Type<Fields>,
      readDependencies: () => Schema.Struct.Type<Fields>,
    ) => Stream.Stream<Message, never, Services>
  },
) => SubscriptionEntry<Model, Message, Schema.Struct.Type<Fields>, Services>

/**
 * Stable dependency key for a query request. For a `QueryRequest` the
 * definition name + serialized args identify the query without invoking
 * `query.fn` (which needs ctx we don't have at dependency-computation time);
 * a ready `Query` hashes directly.
 */
const requestKeyOf = (request: unknown): string => {
  if (request === null || request === undefined) {
    return ''
  }
  if (typeof request === 'object' && 'query' in request) {
    const { query, args } = request as {
      query: { queryName: string }
      args?: unknown
    }
    return `${query.queryName}::${JSON.stringify(args ?? null)}`
  }
  return asQueryInternals(request as Parameters<typeof asQueryInternals>[0]).hash()
}

/**
 * Derives the dependency key that decides when the Zero instance itself was
 * swapped (login/logout/identity change), from the same options the
 * ManagedResource watches. Non-identity fields (mutators, schema) are app
 * constants and intentionally excluded.
 */
const zeroKeyOf = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  maybeOptions: Option.Option<ZeroOptions<any, any, any>>,
): string =>
  Option.isSome(maybeOptions)
    ? JSON.stringify({
        auth: maybeOptions.value.auth ?? null,
        userID: maybeOptions.value.userID ?? null,
        storageKey: maybeOptions.value.storageKey ?? null,
      })
    : ''

/** The stream of results one materialized view produces. */
const viewStream = <
  S extends BaseDefaultSchema,
  TReturn,
  Message,
>(
  zero: Zero<S, any, any>,
  request: QueryOrQueryRequest<
    keyof S['tables'] & string,
    any,
    any,
    S,
    TReturn,
    any
  >,
  ttl: TTL,
  toMessage: (
    data: HumanReadable<TReturn> | undefined,
    details: QueryResultDetails,
  ) => Message,
): Stream.Stream<Message> =>
  Stream.callback<Message>(queue =>
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          let view: TypedView<HumanReadable<TReturn>>
          let unlisten: () => void

          const materialize = () => {
            view = zero.materialize(request as any, { ttl })
            unlisten = view.addListener(emit)
          }

          function retry() {
            unlisten()
            view.destroy()
            materialize()
          }

          function emit(
            data: Immutable<HumanReadable<TReturn>>,
            resultType: ResultType,
            error?: ErroredQuery,
          ) {
            const details: QueryResultDetails =
              resultType === 'error'
                ? {
                    type: 'error',
                    retry,
                    refetch: retry,
                    error: {
                      type: error?.error === 'app' ? 'app' : 'parse',
                      message:
                        error?.message ?? 'An unknown error occurred',
                      ...(error?.details !== undefined
                        ? { details: error.details }
                        : {}),
                    },
                  }
                : { type: resultType }
            Queue.offerUnsafe(
              queue,
              toMessage(
                data as unknown as HumanReadable<TReturn>,
                details,
              ),
            )
          }

          materialize()

          return () => {
            unlisten()
            view.destroy()
          }
        }),
        cleanup => Effect.sync(cleanup),
      )
      return yield* Effect.never
    }),
  )

/**
 * Everything an app needs to wire a Zero instance into a Foldkit runtime.
 *
 * ```ts
 * export const ZeroClient = makeZeroClient<Schema, Mutators, AuthData | undefined>()('Zero')
 * ```
 *
 * Then `ZeroClient.bind(modelToOptions)` produces the per-Model helpers the
 * app drops into `ManagedResource.make` and `Subscription.make`.
 */
export const makeZeroClient =
  <
    S extends BaseDefaultSchema,
    MD extends CustomMutatorDefs | undefined,
    C extends BaseDefaultContext,
  >() =>
  <const Key extends string>(key: Key) => {
    type ZeroInstance = Zero<S, MD, C>

    const tag = ManagedResource.tag<ZeroInstance>()(key)
    type Service = ManagedResource.ServiceOf<typeof tag>

    /** Wait until the resource holds an instance (e.g. mid re-acquire). */
    const getZero = tag.get.pipe(
      Effect.retry(Schedule.spaced(50)),
      Effect.orDie,
    )

    /**
     * Binds a `modelToOptions` to per-Model helpers. The same function is used
     * for both the ManagedResource (which acquires the Zero) and the query
     * subscriptions (which rematerialize views when the instance swaps).
     */
    const bind = <Model>(
      modelToOptions: (
        model: Model,
      ) => Option.Option<ZeroOptions<S, MD, C>>,
    ) => ({
      /**
       * ManagedResource entry owning the `Zero` instance lifecycle:
       * acquires `new Zero(options)` while `modelToOptions` yields `Some`,
       * `zero.close()`s on `None` or on any requirements change.
       */
      resource: <Message>(
        entry: ManagedResourceEntryBuilder<Model, Message>,
        handlers: {
          readonly onAcquired: (zero: ZeroInstance) => Message
          readonly onReleased: () => Message
          readonly onAcquireError: (error: unknown) => Message
        },
      ) =>
        entry(Schema.Option(Schema.Any), {
          resource: tag,
          modelToMaybeRequirements: modelToOptions,
          acquire: options =>
            Effect.sync(
              () => new Zero(options as ZeroOptions<S, MD, C>) as ZeroInstance,
            ),
          release: zero => Effect.promise(() => zero.close()),
          onAcquired: handlers.onAcquired,
          onReleased: handlers.onReleased,
          onAcquireError: handlers.onAcquireError,
        }),

      /**
       * Subscription entry: materializes a Zero query and streams every
       * committed result through `toMessage` — the `useQuery` equivalent.
       *
       * The view is rebuilt only when the query's hash, the ttl, or the Zero
       * instance itself (auth/identity) changes. While `modelToRequest`
       * returns `null`/`undefined` — or the app is logged out — exactly one
       * `toMessage(undefined, {type:'unknown'})` is emitted.
       */
      query: <Message, TReturn>(
        entry: SubscriptionEntryBuilder<Model, Message, Service>,
        config: {
          readonly modelToRequest: (
            model: Model,
          ) =>
            | QueryOrQueryRequest<
                keyof S['tables'] & string,
                any,
                any,
                S,
                TReturn,
                C
              >
            | null
            | undefined
          readonly toMessage: (
            data: HumanReadable<TReturn> | undefined,
            details: QueryResultDetails,
          ) => Message
          readonly ttl?: TTL | undefined
        },
      ) =>
        entry(
          {
            requestKey: Schema.String,
            zeroKey: Schema.String,
            request: Schema.Any,
            ttl: Schema.Any,
          },
          {
            modelToDependencies: model => {
              const request = config.modelToRequest(model)
              return {
                requestKey: requestKeyOf(request),
                zeroKey: zeroKeyOf(modelToOptions(model)),
                request,
                ttl: config.ttl ?? 'forever',
              }
            },
            // `request` is intentionally opaque to the comparison: a fresh
            // query object for the same requestKey must not rebuild the view.
            keepAliveEquivalence: (a, b) =>
              a.requestKey === b.requestKey &&
              a.zeroKey === b.zeroKey &&
              a.ttl === b.ttl,
            dependenciesToStream: ({ zeroKey, request, ttl }) =>
              zeroKey === '' || request === null || request === undefined
                ? Stream.make(config.toMessage(undefined, clearedDetails))
                : Stream.unwrap(
                    Effect.gen(function* () {
                      const zero = yield* getZero
                      return viewStream(zero, request, ttl, config.toMessage)
                    }),
                  ),
          },
        ),

      /**
       * Subscription entry emitting `toMessage(state)` on every connection
       * state transition. While logged out a single
       * `toMessage({name:'closed', reason:'logged out'})` is emitted.
       */
      connectionState: <Message>(
        entry: SubscriptionEntryBuilder<Model, Message, Service>,
        config: { readonly toMessage: (state: ConnectionState) => Message },
      ) =>
        entry(
          { zeroKey: Schema.String },
          {
            modelToDependencies: model => ({
              zeroKey: zeroKeyOf(modelToOptions(model)),
            }),
            keepAliveEquivalence: (a, b) => a.zeroKey === b.zeroKey,
            dependenciesToStream: ({ zeroKey }) =>
              zeroKey === ''
                ? Stream.make(
                    config.toMessage({
                      name: 'closed',
                      reason: 'logged out',
                    }),
                  )
                : Stream.unwrap(
                    Effect.gen(function* () {
                      const zero = yield* getZero
                      return Stream.callback<Message>(queue =>
                        Effect.gen(function* () {
                          yield* Effect.acquireRelease(
                            Effect.sync(() =>
                              zero.connection.state.subscribe(state =>
                                Queue.offerUnsafe(
                                  queue,
                                  config.toMessage(state),
                                ),
                              ),
                            ),
                            unsubscribe => Effect.sync(unsubscribe),
                          )
                          return yield* Effect.never
                        }),
                      )
                    }),
                  ),
          },
        ),
    })

    /** One-shot query — `zero.run`. Resolves once the result is complete. */
    const run = <TReturn>(
      request: QueryOrQueryRequest<
        keyof S['tables'] & string,
        any,
        any,
        S,
        TReturn,
        C
      >,
      options?: RunOptions,
    ): Effect.Effect<HumanReadable<TReturn>, unknown, Service> =>
      Effect.gen(function* () {
        const zero = yield* getZero
        return yield* Effect.tryPromise(
          () => zero.run(request as any, options) as Promise<HumanReadable<TReturn>>,
        )
      })

    /**
     * Fire a mutator — `zero.mutate`. Returns the resolved result details;
     * `await: 'client'` (default) resolves once the local mutation applies,
     * `'server'` waits for server acknowledgement.
     */
    const mutate = (
      request: MutateRequest<any, S, C, any>,
      options?: { readonly await?: 'client' | 'server' },
    ): Effect.Effect<MutatorResultDetails, never, Service> =>
      Effect.gen(function* () {
        const zero = yield* getZero
        const result = zero.mutate(request)
        return yield* Effect.tryPromise({
          try: () =>
            options?.await === 'server' ? result.server : result.client,
          catch: () => ({
            type: 'error' as const,
            error: {
              type: 'app' as const,
              message: 'Mutation failed',
              details: undefined,
            },
          }),
        }).pipe(Effect.catch(error => Effect.succeed(error)))
      })

    /**
     * Preload a query — `zero.preload`. Returns a handle whose `complete` /
     * `cached` Effects resolve as the rows arrive and whose `cleanup` drops
     * the preload.
     */
    const preload = <TReturn>(
      request: QueryOrQueryRequest<
        keyof S['tables'] & string,
        any,
        any,
        S,
        TReturn,
        C
      >,
      options?: { readonly ttl?: TTL },
    ): Effect.Effect<
      {
        readonly complete: Effect.Effect<void>
        readonly cleanup: Effect.Effect<void>
      },
      never,
      Service
    > =>
      Effect.gen(function* () {
        const zero = yield* getZero
        const handle = zero.preload(request, options)
        return {
          complete: Effect.promise(() => handle.complete),
          cleanup: Effect.sync(() => handle.cleanup()),
        }
      })

    /**
     * Access the live instance's `zero.connection` — e.g. to retry after
     * `needs-auth` with a fresh token.
     */
    const connection: Effect.Effect<
      {
        readonly connect: (auth?: string) => Effect.Effect<void>
        readonly state: ConnectionState
      },
      never,
      Service
    > = Effect.gen(function* () {
      const zero = yield* getZero
      return {
        connect: auth =>
          Effect.promise(() =>
            auth === undefined
              ? zero.connection.connect()
              : zero.connection.connect({ auth }),
          ),
        state: zero.connection.state.current,
      }
    })

    return { tag, bind, run, mutate, preload, connection }
  }
