import { Context, Effect, Layer, Redacted, Result, Scope } from 'effect'
import { NodeHttpServer } from '@effect/platform-node'
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from 'effect/unstable/http'
import { SqlClient } from 'effect/unstable/sql'
import type { ReadonlyJSONValue } from '@rocicorp/zero'
import { jwtVerify, SignJWT, type JWK } from 'jose'
import { nanoid } from 'nanoid'
import { makeMutateHandler, makeQueryHandler, sqlText } from 'zero-effect'
import { jwtDataSchema, type JWTData } from '../shared/auth.ts'
import { queries } from '../shared/queries.ts'
import { schema } from '../shared/schema.ts'
import { assert, must } from '../shared/util.ts'
import { dbProvider as makeDbProvider, PgLive } from './db.ts'
import { machineRoutes } from './machine-routes.ts'
import { createServerMutators } from './server-mutators.ts'

export type AuthFn = (
  headers: Record<string, string | string[] | undefined>,
) => Promise<JWTData | undefined>

const privateJwk = (): JWK =>
  JSON.parse(must(process.env.PRIVATE_JWK, 'PRIVATE_JWK is required')) as JWK

const publicJwk = (): unknown =>
  JSON.parse(must(process.env.VITE_PUBLIC_JWK, 'VITE_PUBLIC_JWK is required'))

const githubOAuthEnabled = () =>
  Boolean(process.env.GITHUB_CLIENT_ID) &&
  Boolean(process.env.GITHUB_CLIENT_SECRET)

export const maybeVerifyAuth: AuthFn = async headers => {
  let authorization = headers['authorization']
  if (Array.isArray(authorization)) {
    authorization = authorization[0]
  }
  if (!authorization) {
    return undefined
  }

  assert(
    authorization.toLowerCase().startsWith('bearer '),
    'Expected Authorization header to start with "Bearer "',
  )
  authorization = authorization.substring('Bearer '.length)

  return jwtDataSchema.parse(
    (await jwtVerify(authorization, publicJwk() as Parameters<typeof jwtVerify>[1])).payload,
  )
}

/**
 * The catch for requests that fail JWT verification. zbugs returns 401 for
 * malformed/expired tokens; absent tokens are anonymous (authData undefined).
 */
const verifiedAuthData = (
  headers: Record<string, string | string[] | undefined>,
) => Effect.tryPromise(() => maybeVerifyAuth(headers))

const urlOf = (request: HttpServerRequest.HttpServerRequest): URL =>
  new URL(request.url, 'http://localhost')

const hostIsSecure = (request: HttpServerRequest.HttpServerRequest) =>
  !(request.headers['host'] ?? '').startsWith('localhost') &&
  !(request.headers['host'] ?? '').startsWith('127.')

const readAuthData = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<
  Result.Result<JWTData | undefined, HttpServerResponse.HttpServerResponse>
> =>
  Effect.result(
    verifiedAuthData(
      request.headers as Record<string, string | string[] | undefined>,
    ),
  ).pipe(
    Effect.map(
      Result.mapError(e =>
        HttpServerResponse.text(
          e instanceof Error ? e.message : 'Invalid token',
          { status: 401 },
        ),
      ),
    ),
  )

const mutateRoute = (
  mutate: ReturnType<typeof makeMutateHandler>,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const authResult = yield* readAuthData(request)
    if (Result.isFailure(authResult)) {
      return authResult.failure
    }
    const body = (yield* request.json) as ReadonlyJSONValue
    const url = urlOf(request)
    const response = yield* mutate({
      query: url.searchParams,
      body,
      authData: authResult.success,
    })
    return yield* HttpServerResponse.json(response)
  })

const queryRoute = (query: ReturnType<typeof makeQueryHandler>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const authResult = yield* readAuthData(request)
    if (Result.isFailure(authResult)) {
      return authResult.failure
    }
    const body = (yield* request.json) as ReadonlyJSONValue
    const url = urlOf(request)
    const response = yield* query({
      query: url.searchParams,
      body,
      authData: authResult.success,
    })
    return yield* HttpServerResponse.json(response)
  })

// ---------------------------------------------------------------------------
// GitHub OAuth -> user upsert -> JWT cookie (mirrors zbugs api/index.ts)
// ---------------------------------------------------------------------------

const loginGithubRoute = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  if (!githubOAuthEnabled()) {
    return HttpServerResponse.text('GitHub OAuth not configured', {
      status: 501,
    })
  }
  const url = urlOf(request)
  const proto = hostIsSecure(request) ? 'https' : 'http'
  const host = request.headers['host'] ?? 'localhost:5173'
  const redirect = url.searchParams.get('redirect')
  const callbackUri =
    `${proto}://${host}/api/login/github/callback` +
    (redirect ? `?redirect=${encodeURIComponent(redirect)}` : '')
  return HttpServerResponse.redirect(
    `https://github.com/login/oauth/authorize?client_id=${process.env.GITHUB_CLIENT_ID}&redirect_uri=${encodeURIComponent(callbackUri)}`,
  )
})

interface GithubUser {
  readonly id: number
  readonly login: string
  readonly name: string | null
  readonly avatar_url: string
  readonly email: string | null
}

const loginGithubCallbackRoute = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const client = yield* SqlClient.SqlClient
  if (!githubOAuthEnabled()) {
    return HttpServerResponse.text('GitHub OAuth not configured', {
      status: 501,
    })
  }
  const url = urlOf(request)
  const code = url.searchParams.get('code')
  if (!code) {
    return HttpServerResponse.text('Missing OAuth code', { status: 400 })
  }
  const redirectParam = url.searchParams.get('redirect')

  const tokenResponse = yield* Effect.tryPromise(() =>
    fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
      }),
    }).then(r => r.json()),
  )
  const accessToken = (tokenResponse as { access_token?: string }).access_token
  if (!accessToken) {
    return HttpServerResponse.text('GitHub OAuth token exchange failed', {
      status: 401,
    })
  }

  const userDetails = yield* Effect.tryPromise(() =>
    fetch('https://api.github.com/user', {
      headers: {
        authorization: `Bearer ${accessToken}`,
        'x-github-api-version': '2022-11-28',
      },
    }).then(r => r.json() as Promise<GithubUser>),
  )

  let userId = nanoid()
  const existingUser = yield* client.unsafe<{ id: string; email: string | null }>(
    `SELECT id, email FROM "user" WHERE "githubID" = $1`,
    [userDetails.id],
  )
  if (existingUser.length > 0) {
    userId = must(existingUser[0]).id
    // update email on login if it has changed
    if (must(existingUser[0]).email !== userDetails.email) {
      yield* client.unsafe(`UPDATE "user" SET "email" = $1 WHERE "id" = $2`, [
        userDetails.email,
        userId,
      ])
    }
  } else {
    yield* client.unsafe(
      `INSERT INTO "user"
        ("id", "login", "name", "avatar", "githubID", "email") VALUES (
          $1, $2, $3, $4, $5, $6
        )`,
      [
        userId,
        userDetails.login,
        userDetails.name,
        userDetails.avatar_url,
        userDetails.id,
        userDetails.email,
      ],
    )
  }

  const userRows = yield* client.unsafe<{ role: string }>(
    `SELECT * FROM "user" WHERE "id" = $1`,
    [userId],
  )

  const jwk = privateJwk()
  const jwtPayload: JWTData = {
    sub: userId,
    iat: Math.floor(Date.now() / 1000),
    role: must(userRows[0]).role as JWTData['role'],
    name: userDetails.login,
    exp: 0, // setExpirationTime below sets it
  }

  const jwt = yield* Effect.tryPromise(() =>
    new SignJWT(jwtPayload)
      .setProtectedHeader({ alg: must(jwk.alg) })
      .setExpirationTime('30days')
      .sign(jwk),
  )

  const proto = hostIsSecure(request) ? 'https' : 'http'
  const host = request.headers['host'] ?? 'localhost:5173'
  const location = redirectParam
    ? decodeURIComponent(redirectParam)
    : `${proto}://${host}/`

  return yield* HttpServerResponse.setCookie(
    HttpServerResponse.redirect(location, { status: 302 }),
    'jwt',
    jwt,
    {
      path: '/',
      expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      secure: hostIsSecure(request),
      sameSite: 'strict',
    },
  )
})

const unsubscribeRoute = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const client = yield* SqlClient.SqlClient
  const url = urlOf(request)
  const email = url.searchParams.get('email')
  const idParam = url.searchParams.get('id')

  if (!email) {
    return HttpServerResponse.text('Email is required', { status: 400 })
  }
  const shortID = parseInt(idParam ?? '')
  if (isNaN(shortID)) {
    return HttpServerResponse.text('Invalid issue ID', { status: 400 })
  }

  const existingUser = yield* client.unsafe<{ id: string }>(
    `SELECT id, email FROM "user" WHERE "email" = $1`,
    [email],
  )
  const user = existingUser[0]
  if (!user) {
    return HttpServerResponse.text('Unauthorized', { status: 401 })
  }

  const issueResult = yield* client.unsafe<{ id: string; title: string }>(
    `SELECT id, title FROM "issue" WHERE "shortID" = $1`,
    [shortID],
  )
  const issue = issueResult[0]
  if (!issue) {
    return HttpServerResponse.text('Issue not found', { status: 404 })
  }

  yield* client.unsafe(
    `INSERT INTO "issueNotifications" ("userID", "issueID", "subscribed")
     VALUES ($1, $2, false)
     ON CONFLICT ("userID", "issueID")
     DO UPDATE SET "subscribed" = false`,
    [user.id, issue.id],
  )
  return HttpServerResponse.html(
    `OK! You are unsubscribed from <a href="https://bugs.rocicorp.dev/issue/${shortID}">${issue.title}</a>.`,
  )
})

/**
 * Builds the node `(req, res)` request handler for the whole API — mounted
 * into the vite dev server like zbugs mounts fastify, so ONE port serves the
 * app, `/api/*`, and `/p/*.md`.
 */
export const apiHandler = (
  scope: Scope.Scope,
): Effect.Effect<
  (
    nodeRequest: import('node:http').IncomingMessage,
    nodeResponse: import('node:http').ServerResponse,
  ) => void,
  unknown,
  never
> =>
  Effect.gen(function* () {
  // Built under `scope` (the app-level scope from the vite plugin) so the
  // pool outlives this handler-construction effect and is only closed when
  // the dev server shuts down.
  const services = yield* Layer.buildWithScope(PgLive, scope)
  const client = Context.get(services, SqlClient.SqlClient)
  const dbProvider = makeDbProvider(client)

  const mutate = makeMutateHandler({
    dbProvider,
    createMutators: createServerMutators,
    logLevel: 'info',
  })
  const query = makeQueryHandler({
    schema,
    queries,
    logLevel: 'info',
  })

  const apiLayer = HttpRouter.addAll([
    HttpRouter.route('POST', '/api/mutate', mutateRoute(mutate)),
    HttpRouter.route('POST', '/api/push', mutateRoute(mutate)),
    HttpRouter.route('POST', '/api/query', queryRoute(query)),
    HttpRouter.route('POST', '/api/get-queries', queryRoute(query)),
    HttpRouter.route('GET', '/api/login/github', loginGithubRoute),
    HttpRouter.route('GET', '/api/login/github/callback', loginGithubCallbackRoute),
    HttpRouter.route('GET', '/api/unsubscribe', unsubscribeRoute),
    machineRoutes(dbProvider, maybeVerifyAuth),
  ]).pipe(
    HttpRouter.provideRequest(Layer.succeed(SqlClient.SqlClient, client)),
  )

  const httpEffect = yield* HttpRouter.toHttpEffect(apiLayer)
  return yield* NodeHttpServer.makeHandler(httpEffect, { scope })
  }).pipe(
    Effect.provideService(Scope.Scope, scope),
  )
