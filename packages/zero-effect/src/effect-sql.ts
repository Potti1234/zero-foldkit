import { Effect, Option } from 'effect'
import type { SqlClient } from 'effect/unstable/sql/SqlClient'
import type { Connection } from 'effect/unstable/sql/SqlConnection'
import type { SqlError } from 'effect/unstable/sql/SqlError'
import type {
  AST,
  Format,
  HumanReadable,
  Schema,
} from '@rocicorp/zero'
import type {
  DBConnection,
  DBTransaction,
  Row,
  ServerSchema,
} from '@rocicorp/zero/server'
import {
  executePostgresQuery,
  ZQLDatabase,
} from '@rocicorp/zero/server'

/**
 * Run a SQL statement against a Zero {@linkcode ServerTransaction}'s wrapped
 * transaction (`tx.dbTransaction.wrappedTransaction`) inside a server mutator.
 *
 * ```ts
 * await Effect.runPromise(
 *   sqlText(tx.dbTransaction.wrappedTransaction, 'INSERT INTO "user" (id) VALUES ($1)', [args.id]),
 * )
 * ```
 */
export const sqlText = (
  connection: Connection,
  sql: string,
  params: ReadonlyArray<unknown> = [],
): Effect.Effect<readonly Row[], SqlError> =>
  connection.execute(sql, params, undefined)

/**
 * Zero {@linkcode DBConnection} backed by an `effect` `SqlClient`.
 *
 * `wrappedTransaction` handed to server mutators is the raw `effect` SQL
 * `Connection` bound to the active transaction — use {@linkcode sqlText} to
 * run statements against it.
 */
export class EffectSqlConnection implements DBConnection<Connection> {
  readonly #client: SqlClient

  constructor(client: SqlClient) {
    this.#client = client
  }

  query(sql: string, params: unknown[]): Promise<Row[]> {
    return Effect.runPromise(
      this.#client.unsafe<Row>(sql, params).pipe(
        Effect.map(rows => [...rows]),
        Effect.scoped,
      ),
    )
  }

  transaction<TRet>(
    fn: (tx: DBTransaction<Connection>) => Promise<TRet>,
  ): Promise<TRet> {
    const client = this.#client
    return Effect.runPromise(
      Effect.scoped(
        client.withTransaction(
          Effect.serviceOption(client.transactionService).pipe(
            Effect.flatMap(maybeConnection =>
              Option.isSome(maybeConnection)
                ? Effect.tryPromise(() =>
                    fn(new EffectSqlTransaction(maybeConnection.value[0])),
                  )
                : Effect.die(
                    new Error(
                      'sql transaction connection missing',
                    ),
                  ),
            ),
          ),
        ),
      ),
    )
  }
}

export class EffectSqlTransaction implements DBTransaction<Connection> {
  readonly wrappedTransaction: Connection

  constructor(connection: Connection) {
    this.wrappedTransaction = connection
  }

  query(sql: string, params: unknown[]): Promise<Row[]> {
    return Effect.runPromise(sqlText(this.wrappedTransaction, sql, params).pipe(
      Effect.map(rows => [...rows]),
      Effect.scoped,
    ))
  }

  runQuery<TReturn>(
    ast: AST,
    format: Format,
    schema: Schema,
    serverSchema: ServerSchema,
  ): Promise<HumanReadable<TReturn>> {
    return executePostgresQuery<TReturn>(
      this,
      ast,
      format,
      schema,
      serverSchema,
    )
  }
}

/**
 * Wrap an `effect` `SqlClient` for Zero ZQL — the `@effect/sql` counterpart of
 * `zeroPostgresJS` / `zeroDrizzle` etc.
 *
 * ```ts
 * const sql = yield* SqlClient
 * const zql = zeroEffectSql(schema, sql)
 * ```
 */
export const zeroEffectSql = <S extends Schema>(
  schema: S,
  client: SqlClient,
): ZQLDatabase<S, Connection> =>
  new ZQLDatabase(new EffectSqlConnection(client), schema)
