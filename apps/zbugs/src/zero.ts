import type { AnyMutatorRegistry, ZeroOptions } from '@rocicorp/zero'
import { Option } from 'effect'
import type { ManagedResource } from 'foldkit'
import { makeZeroClient } from 'zero-foldkit'
import type { AuthData } from '../shared/auth.ts'
import { mutators } from '../shared/mutators.ts'
import { schema } from '../shared/schema.ts'
import type { Login } from './auth.ts'

/**
 * The one Zero client adapter for the app. Every page binds its own
 * `modelToOptions` over this so auth-driven Zero swaps propagate everywhere.
 *
 * `defineMutators` produces a `MutatorRegistry`, which `ZeroOptions.mutators`
 * accepts when `MD` stays `undefined` — the registry itself is passed through.
 */
export const ZeroClient = makeZeroClient<
  typeof schema,
  undefined,
  AuthData | undefined
>()('Zero')

export type ZeroService = ManagedResource.ServiceOf<typeof ZeroClient.tag>

export const zeroOptions = (
  maybeLogin: Option.Option<Login>,
): ZeroOptions<typeof schema, undefined, AuthData | undefined> => ({
  schema,
  mutators: mutators as unknown as AnyMutatorRegistry,
  cacheURL: (import.meta.env['VITE_PUBLIC_SERVER'] ??
    'http://localhost:4848') as string,
  userID: Option.map(maybeLogin, ({ decoded }) => decoded.sub).pipe(
    Option.getOrUndefined,
  ),
  auth: Option.map(maybeLogin, ({ encoded }) => encoded).pipe(
    Option.getOrUndefined,
  ),
  context: Option.map(maybeLogin, ({ decoded }) => ({
    sub: decoded.sub,
    role: decoded.role,
  })).pipe(Option.getOrUndefined),
  mutateURL: `${window.location.origin}/api/mutate`,
  queryURL: `${window.location.origin}/api/query`,
  logLevel: 'info',
})
