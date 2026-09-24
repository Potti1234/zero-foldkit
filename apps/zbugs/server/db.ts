import { Redacted } from 'effect'
import { PgClient } from '@effect/sql-pg'
import type { SqlClient } from 'effect/unstable/sql/SqlClient'
import { zeroEffectSql } from 'zero-effect'
import { schema } from '../shared/schema.ts'
import { must } from '../shared/util.ts'

export const PgLive = PgClient.layer({
  url: Redacted.make(
    must(process.env.ZERO_UPSTREAM_DB, 'ZERO_UPSTREAM_DB is required'),
  ),
})

export const dbProvider = (client: SqlClient) =>
  zeroEffectSql(schema, client)

declare module '@rocicorp/zero' {
  interface DefaultTypes {
    dbProvider: ReturnType<typeof dbProvider>
  }
}
