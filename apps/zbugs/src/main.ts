import { Command, ManagedResource, Runtime, Subscription, Update, Url } from 'foldkit'
import { UrlRequest, load, pushUrl } from 'foldkit/navigation'
import { defineMessageUnion } from 'foldkit/message'
import type { Document } from 'foldkit/html'
import { modifyFields } from 'foldkit/struct'
import { Effect, Match, Option, Schema } from 'effect'
import type { ConnectionState } from '@rocicorp/zero'
import { ZERO_PROJECT_NAME } from '../shared/schema.ts'
import { queries } from '../shared/queries.ts'
import { getIDFromString } from '../shared/issue-id.ts'
import { clearJwt, getLogin, type Login } from './auth.ts'
import * as List from './page/list.ts'
import * as Issue from './page/issue.ts'
import { AppRoute, routeToUrlPath, urlToAppRoute } from './route.ts'
import { ZeroClient, type ZeroService, zeroOptions } from './zero.ts'

// MODEL

export const Model = Schema.Struct({
  route: AppRoute,
  login: Schema.Option(
    Schema.Struct({ encoded: Schema.String, decoded: Schema.Any }),
  ),
  connectionState: Schema.Any,
  maybeList: Schema.Option(List.Model),
  maybeIssue: Schema.Option(Issue.Model),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  CompletedNavigateInternal: {},
  CompletedLoadExternal: {},
  CompletedResolveDeprecatedIssue: {},
  FailedResolveDeprecatedIssue: { error: Schema.String },
  ClickedLink: { request: UrlRequest },
  ChangedUrl: { url: Url.Url },
  ChangedConnectionState: { state: Schema.Any },
  AcquiredZero: {},
  ReleasedZero: {},
  FailedAcquireZero: { error: Schema.String },
  ClickedLogin: {},
  ClickedLogout: {},
  GotListMessage: { message: List.Message },
  GotIssueMessage: { message: Issue.Message },
})
export type Message = typeof Message.Type

// ZERO BINDING (root model → options; login change reacquires Zero)

const bound = ZeroClient.bind<Model>(model =>
  Option.some(zeroOptions(model.login as Option.Option<Login>)),
)

// COMMANDS

const NavigateInternal = Command.define('NavigateInternal', {
  args: { url: Schema.String },
  messages: [Message.CompletedNavigateInternal],
  execute: ({ url }) =>
    pushUrl(url).pipe(Effect.as(Message.CompletedNavigateInternal())),
})

const LoadExternal = Command.define('LoadExternal', {
  args: { href: Schema.String },
  messages: [Message.CompletedLoadExternal],
  execute: ({ href }) =>
    load(href).pipe(Effect.as(Message.CompletedLoadExternal())),
})

const ResolveDeprecatedIssue = Command.define('ResolveDeprecatedIssue', {
  args: { id: Schema.String },
  messages: [
    Message.CompletedResolveDeprecatedIssue,
    Message.FailedResolveDeprecatedIssue,
  ],
  execute: ({ id }) =>
    Effect.gen(function* () {
      const { idField, idValue } = getIDFromString(id)
      const issue = yield* ZeroClient.run(
        queries.issueDetail({ idField, id: idValue }),
      )
      const detail = issue as
        | { project?: { name?: string }; shortID?: number | null; id?: string }
        | undefined
      if (detail?.project?.name) {
        yield* pushUrl(
          routeToUrlPath(
            AppRoute.Issue({
              projectName: detail.project.name.toLowerCase(),
              id: String(detail.shortID ?? detail.id ?? id),
            }),
          ),
        )
      }
      return Message.CompletedResolveDeprecatedIssue()
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedResolveDeprecatedIssue({ error: String(error) }),
        ),
      ),
    ),
})

// INIT

type InitCommands = Update.Commands<Message, ZeroService>

const initList = (
  projectName: string,
  login: Option.Option<Login>,
) => List.init(projectName, login)

const initIssue = (
  projectName: string,
  id: string,
  login: Option.Option<Login>,
) => Issue.init(projectName, id, login)

export const init: Runtime.RoutingApplicationInit<
  Model,
  Message,
  void,
  ZeroService
> = (url: Url.Url) => {
  const route = urlToAppRoute(url)
  const login = getLogin() as Model['login']

  const commands: InitCommands = AppRoute.match<InitCommands>(route, {
    Home: () => [
      NavigateInternal({
        url: routeToUrlPath(
          AppRoute.List({ projectName: ZERO_PROJECT_NAME.toLowerCase() }),
        ),
      }),
    ],
    DeprecatedIssue: ({ id }) => [ResolveDeprecatedIssue({ id })],
    List: () => [],
    Issue: () => [],
    NotFound: () => [],
  })

  const model: Model = {
    route,
    login,
    connectionState: null,
    maybeList:
      route._tag === 'List' || route._tag === 'Home'
        ? Option.some(
            initList(
              route._tag === 'List'
                ? route.projectName
                : ZERO_PROJECT_NAME.toLowerCase(),
              login,
            ).model,
          )
        : Option.none(),
    maybeIssue:
      route._tag === 'Issue'
        ? Option.some(
            initIssue(route.projectName, route.id, login).model,
          )
        : Option.none(),
  }
  return { model, commands }
}

// SUBSCRIPTIONS

const connectionStates = Subscription.make<Model, Message, ZeroService>()(
  entry => ({
    connectionState: bound.connectionState(entry, {
      toMessage: (state: ConnectionState) =>
        Message.ChangedConnectionState({ state }),
    }),
  }),
)

const listSubscriptions = Subscription.lift(List.subscriptions)({
  toChildModel: (model: Model) => Option.getOrThrow(model.maybeList),
  when: model => Option.isSome(model.maybeList),
  toParentMessage: (message: List.Message): Message =>
    Message.GotListMessage({ message }),
})

const issueSubscriptions = Subscription.lift(Issue.subscriptions)({
  toChildModel: (model: Model) => Option.getOrThrow(model.maybeIssue),
  when: model => Option.isSome(model.maybeIssue),
  toParentMessage: (message: Issue.Message): Message =>
    Message.GotIssueMessage({ message }),
})

export const subscriptions = Subscription.aggregate(
  connectionStates,
  listSubscriptions,
  issueSubscriptions,
)

// MANAGED RESOURCES

export const managedResources = ManagedResource.make<Model, Message>()(
  entry => ({
    zero: bound.resource(entry, {
      onAcquired: () => Message.AcquiredZero(),
      onReleased: () => Message.ReleasedZero(),
      onAcquireError: error =>
        Message.FailedAcquireZero({ error: String(error) }),
    }),
  }),
)

// UPDATE

type UpdateReturn = Update.Return<Model, Message, ZeroService>
const withUpdateReturn = Match.withReturnType<UpdateReturn>()

const readList = (model: Model): Option.Option<List.Model> => model.maybeList

const writeList = (model: Model, nextList: List.Model): Model =>
  modifyFields(model, { maybeList: () => Option.some(nextList) })

const toGotListMessage = (message: List.Message): Message =>
  Message.GotListMessage({ message })

const readIssue = (model: Model): Option.Option<Issue.Model> =>
  model.maybeIssue

const writeIssue = (model: Model, nextIssue: Issue.Model): Model =>
  modifyFields(model, { maybeIssue: () => Option.some(nextIssue) })

const toGotIssueMessage = (message: Issue.Message): Message =>
  Message.GotIssueMessage({ message })

const foldListMessage = Update.foldChild({
  update: List.update,
  read: readList,
  write: writeList,
  toParentMessage: toGotListMessage,
})

const foldIssueMessage = Update.foldChild({
  update: Issue.update,
  read: readIssue,
  write: writeIssue,
  toParentMessage: toGotIssueMessage,
})

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    ClickedLink: ({ request }) =>
      UrlRequest.match<UpdateReturn>(request, {
        Internal: ({ url }) => ({
          model,
          commands: [
            NavigateInternal({ url: Url.toString(url) }),
          ],
        }),
        External: ({ href }) => ({
          model,
          commands: [LoadExternal({ href })],
        }),
      }),

    ChangedUrl: ({ url }) => {
      const route = urlToAppRoute(url)
      const commands: Update.Commands<Message, ZeroService> =
        AppRoute.match<Update.Commands<Message, ZeroService>>(route, {
          Home: () => [
            NavigateInternal({
              url: routeToUrlPath(
                AppRoute.List({
                  projectName: ZERO_PROJECT_NAME.toLowerCase(),
                }),
              ),
            }),
          ],
          DeprecatedIssue: ({ id }) => [ResolveDeprecatedIssue({ id })],
          List: () => [],
          Issue: () => [],
          NotFound: () => [],
        })
      return {
        model: modifyFields(model, {
          route: () => route,
          maybeList: () =>
            route._tag === 'List'
              ? Option.isSome(model.maybeList) &&
                Option.getOrThrow(model.maybeList).projectName ===
                  route.projectName
                ? model.maybeList
                : Option.some(
                    initList(route.projectName, model.login).model,
                  )
              : model.maybeList,
          maybeIssue: () =>
            route._tag === 'Issue'
              ? Option.some(
                  initIssue(route.projectName, route.id, model.login).model,
                )
              : model.maybeIssue,
        }),
        commands,
      }
    },

    ChangedConnectionState: ({ state }) => ({
      model: modifyFields(model, {
        connectionState: () => state,
      }),
    }),

    AcquiredZero: () => ({ model }),
    ReleasedZero: () => ({ model }),
    FailedAcquireZero: () => ({ model }),

    ClickedLogin: () => ({
      model,
      commands: [
        LoadExternal({
          href:
            '/api/login/github?redirect=' +
            encodeURIComponent(window.location.pathname),
        }),
      ],
    }),

    ClickedLogout: () => {
      clearJwt()
      return {
        model,
        commands: [LoadExternal({ href: '/' })],
      }
    },

    GotListMessage: ({ message }) => foldListMessage(model, message),

    GotIssueMessage: ({ message }) => foldIssueMessage(model, message),

    CompletedNavigateInternal: () => ({ model }),
    CompletedLoadExternal: () => ({ model }),
    CompletedResolveDeprecatedIssue: () => ({ model }),
    FailedResolveDeprecatedIssue: () => ({ model }),
  })

// VIEW

const statusPill = (state: ConnectionState | null): string =>
  state === null ? '…' : state.name

export const view = (
  model: Model,
  h: import('foldkit/html').HtmlBuilder<Message>,
): Document => {

  const nav = h.div(
    [
      h.Class(
        'flex items-center gap-4 px-5 py-3 border-b border-gray-800 bg-gray-950',
      ),
    ],
    [
      h.a(
        [
          h.Class('text-gray-100 font-bold text-lg tracking-tight'),
          h.Href(
            routeToUrlPath(
              AppRoute.List({
                projectName: ZERO_PROJECT_NAME.toLowerCase(),
              }),
            ),
          ),
        ],
        ['🐛 zbugs'],
      ),
      h.span([h.Class('flex-1')], []),
      h.span(
        [h.Class('text-xs text-gray-500')],
        [`${statusPill(model.connectionState as ConnectionState | null)}`],
      ),
      ...(Option.isSome(model.login)
        ? [
            h.span(
              [h.Class('text-gray-300 text-sm')],
              [
                (model.login.value.decoded as { name?: string }).name ??
                  'signed in',
              ],
            ),
            h.button(
              [
                h.Class(
                  'px-3 py-1.5 rounded border border-gray-700 bg-gray-800 text-gray-100 text-sm',
                ),
                h.OnClick(Message.ClickedLogout()),
              ],
              ['Log out'],
            ),
          ]
        : [
            h.button(
              [
                h.Class(
                  'px-3 py-1.5 rounded bg-blue-600 text-white text-sm hover:bg-blue-500',
                ),
                h.OnClick(Message.ClickedLogin()),
              ],
              ['Log in with GitHub'],
            ),
          ]),
    ],
  )

  const body = AppRoute.match(model.route, {
    Home: () =>
      h.div([h.Class('text-gray-400 p-8 text-center')], ['Redirecting…']),
    List: () =>
      Option.match(model.maybeList, {
        onNone: () =>
          h.div(
            [h.Class('text-gray-400 p-8 text-center')],
            ['Loading…'],
          ),
        onSome: listModel =>
          h.div(
            [h.Class('p-5')],
            [
              h.submodel({
                slotId: 'list',
                model: listModel,
                view: List.view,
                toParentMessage: (message: List.Message) =>
                  Message.GotListMessage({ message }),
              }),
            ],
          ),
      }),
    Issue: () =>
      Option.match(model.maybeIssue, {
        onNone: () =>
          h.div(
            [h.Class('text-gray-400 p-8 text-center')],
            ['Loading…'],
          ),
        onSome: issueModel =>
          h.div(
            [h.Class('p-5 max-w-4xl')],
            [
              h.submodel({
                slotId: 'issue',
                model: issueModel,
                view: Issue.view,
                toParentMessage: (message: Issue.Message) =>
                  Message.GotIssueMessage({ message }),
              }),
            ],
          ),
      }),
    DeprecatedIssue: () =>
      h.div([h.Class('text-gray-400 p-8 text-center')], ['Redirecting…']),
    NotFound: () =>
      h.div([h.Class('text-gray-400 p-8 text-center')], [
        '404 — page not found',
      ]),
  })

  return {
    title: 'zbugs — zero issue tracker',
    body: h.div(
      [h.Class('min-h-screen bg-gray-950 text-gray-100 font-sans')],
      [nav, body],
    ),
  }
}
