import { Effect } from 'effect'
import type {
  AnyCustomQuery,
  Mutator,
  MutatorDefinitions,
  MutatorRegistry,
  QueryDefinitions,
  QueryRegistry,
  ReadonlyJSONValue,
  Schema,
} from '@rocicorp/zero'
import {
  mustGetMutator,
  mustGetQuery,
} from '@rocicorp/zero'
import type {
  Database,
  ExtractTransactionType,
  MutateRequestHandler,
  MutateResponse,
  QueryResponse,
  TransactFn,
} from '@rocicorp/zero/server'
import {
  handleMutateRequest,
  handleQueryRequest,
} from '@rocicorp/zero/server'

export type LogLevel =
  | 'debug'
  | 'info'
  | 'warn'
  | 'error'

const defaultToUserID = (ctx: unknown): string | null =>
  ctx === null || ctx === undefined
    ? null
    : ((ctx as { sub?: string | null }).sub ?? null)

/**
 * Builds the `/api/query` endpoint handler Zero expects: transforms each
 * named client query through your `defineQueries` and returns the AST
 * response zero-cache executes.
 *
 * ```ts
 * const queryHandler = makeQueryHandler({ schema, queries })
 *
 * // inside an HttpApi/HttpRouter POST /api/query endpoint:
 * const response = yield* queryHandler({
 *   query: request.query,
 *   body: request.body,
 *   authData,
 * })
 * ```
 */
export const makeQueryHandler = <
  S extends Schema,
  C,
  QD extends QueryDefinitions,
>(
  config: {
    readonly schema: S
    readonly queries: QueryRegistry<QD, S>
    readonly logLevel?: LogLevel
    readonly toUserID?: (
      ctx: C | undefined,
    ) => string | null | undefined
  },
) => {
  const toUserID = config.toUserID ?? defaultToUserID
  return (input: {
    readonly query: URLSearchParams | Record<string, string>
    readonly body: ReadonlyJSONValue
    readonly authData: C | undefined
  }): Effect.Effect<QueryResponse> =>
    Effect.tryPromise(() =>
      handleQueryRequest({
        handler: (name, args) => {
          const query = mustGetQuery(
            config.queries,
            name,
          ) as AnyCustomQuery
          return query.fn({
            args,
            ctx: input.authData,
          })
        },
        schema: config.schema,
        query: input.query,
        body: input.body,
        userID: toUserID(input.authData),
        logLevel: config.logLevel ?? 'error',
      }),
    ).pipe(Effect.orDie)
}

/**
 * Builds the `/api/mutate` endpoint handler: runs each pushed mutation
 * through your server mutators inside a database transaction, then settles
 * the post-commit tasks the mutators enqueued (notifications, emails…) —
 * mirroring the zbugs server.
 *
 * `createMutators` is called per request with the task collector; enqueue
 * work via `postCommitTasks.push(...)`.
 */
export const makeMutateHandler = <
  D extends Database<ExtractTransactionType<D>>,
  S extends Schema,
  MD extends MutatorDefinitions,
  C,
>(config: {
  readonly dbProvider: D
  readonly createMutators: (
    postCommitTasks: Array<() => Promise<void>>,
  ) => MutatorRegistry<MD, S>
  readonly logLevel?: LogLevel
  readonly toUserID?: (
    ctx: C | undefined,
  ) => string | null | undefined
}) => {
  const toUserID = config.toUserID ?? defaultToUserID
  return (input: {
    readonly query: URLSearchParams | Record<string, string>
    readonly body: ReadonlyJSONValue
    readonly authData: C | undefined
  }): Effect.Effect<MutateResponse> =>
    Effect.gen(function* () {
      const postCommitTasks: Array<() => Promise<void>> = []
      const mutators = config.createMutators(postCommitTasks)
      const authData = input.authData

      const handler: MutateRequestHandler<D> = (
        transact: TransactFn<D>,
        _mutation,
      ) =>
        transact((tx, name, args) => {
          const mutator = mustGetMutator(
            mutators,
            name,
          ) as Mutator<ReadonlyJSONValue | undefined, any, any, any>
          return mutator.fn({ tx: tx as never, args, ctx: authData })
        })

      const response = yield* Effect.tryPromise(() =>
        handleMutateRequest({
          dbProvider: config.dbProvider,
          handler,
          query: input.query,
          body: input.body,
          userID: toUserID(authData),
          logLevel: config.logLevel ?? 'error',
        }),
      ).pipe(Effect.orDie)

      // Post-commit work (notifications etc.) is settled but never blocks the
      // mutation response — same as zbugs' Promise.allSettled.
      yield* Effect.tryPromise(() =>
        Promise.allSettled(postCommitTasks.map(task => task())),
      ).pipe(Effect.ignore)

      return response
    })
}
