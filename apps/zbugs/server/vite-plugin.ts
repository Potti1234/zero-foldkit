import { Effect, Scope } from 'effect'
import type { PluginOption, ViteDevServer } from 'vite'
import { apiHandler } from './api.ts'

function isApiPath(url: string): boolean {
  const pathname = url.split('?')[0]
  return (
    pathname.startsWith('/api') ||
    (pathname.startsWith('/p/') && pathname.endsWith('.md'))
  )
}

/**
 * Mounts the Effect API server inside the vite dev server — the foldkit
 * equivalent of zbugs' fastify `configureServer` mount, so dev runs on one
 * port (5173): the app, `/api/*`, and `/p/*.md` all served together.
 */
export const apiServerPlugin = (): PluginOption => ({
  name: 'api-server',
  async configureServer(server: ViteDevServer) {
    const scope = await Effect.runPromise(Scope.make())
    const handler = await Effect.runPromise(apiHandler(scope))
    server.middlewares.use((req, res, next) => {
      if (!req.url || !isApiPath(req.url)) {
        return next()
      }
      handler(req, res)
    })
  },
})
