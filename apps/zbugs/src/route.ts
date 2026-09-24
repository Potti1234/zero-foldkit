import { Schema, pipe } from 'effect'
import {
  defineRouteUnion,
  literal,
  mapTo,
  oneOf,
  parseUrlWithFallback,
  root,
  slash,
  string,
} from 'foldkit/route'

// ROUTES

export const AppRoute = defineRouteUnion({
  Home: {},
  List: { projectName: Schema.String },
  Issue: { projectName: Schema.String, id: Schema.String },
  DeprecatedIssue: { id: Schema.String },
  NotFound: { path: Schema.String },
})
export type AppRoute = typeof AppRoute.Type

// ROUTERS

export const homeRouter = pipe(root, mapTo(AppRoute.Home))

export const listRouter = pipe(
  literal('p'),
  slash(string('projectName')),
  mapTo(AppRoute.List),
)

export const issueRouter = pipe(
  literal('p'),
  slash(string('projectName')),
  slash(literal('issue')),
  slash(string('id')),
  mapTo(AppRoute.Issue),
)

export const deprecatedIssueRouter = pipe(
  literal('issue'),
  slash(string('id')),
  mapTo(AppRoute.DeprecatedIssue),
)

export const routeParser = oneOf(
  issueRouter,
  deprecatedIssueRouter,
  listRouter,
  homeRouter,
)

export const urlToAppRoute = parseUrlWithFallback(
  routeParser,
  AppRoute.NotFound,
)

// URLS

export const routeToUrlPath = (route: AppRoute): string =>
  AppRoute.match(route, {
    Home: () => homeRouter(),
    List: ({ projectName }) => listRouter({ projectName }),
    Issue: ({ projectName, id }) => issueRouter({ projectName, id }),
    DeprecatedIssue: ({ id }) => deprecatedIssueRouter({ id }),
    NotFound: ({ path }) => path,
  })
