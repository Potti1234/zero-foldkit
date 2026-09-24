import { Command, Submodel, Subscription, type Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { modifyFields } from 'foldkit/struct'
import { Effect, Option, Schema } from 'effect'
import { nanoid } from 'nanoid'
import { mutators } from '../../shared/mutators.ts'
import { queries, type Issue } from '../../shared/queries.ts'
import type { Login } from '../auth.ts'
import { AppRoute, routeToUrlPath } from '../route.ts'
import { ZeroClient, type ZeroService, zeroOptions } from '../zero.ts'

const PAGE_SIZE = 200

// MODEL

export const SortField = Schema.Literals(['modified', 'created'])
export type SortField = typeof SortField.Type

export const SortDirection = Schema.Literals(['asc', 'desc'])
export type SortDirection = typeof SortDirection.Type

export const OpenFilter = Schema.Literals(['All', 'Open', 'Closed'])
export type OpenFilter = typeof OpenFilter.Type

export const Model = Schema.Struct({
  projectName: Schema.String,
  maybeLogin: Schema.Option(
    Schema.Struct({ encoded: Schema.String, decoded: Schema.Any }),
  ),
  maybeIssues: Schema.Option(Schema.Array(Schema.Any)),
  maybeProjects: Schema.Option(Schema.Array(Schema.Any)),
  resultType: Schema.String,
  textFilter: Schema.String,
  open: OpenFilter,
  sortField: SortField,
  sortDirection: SortDirection,
  isComposing: Schema.Boolean,
  composerTitle: Schema.String,
  composerDescription: Schema.String,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  SyncedIssues: {
    data: Schema.Option(Schema.Any),
    details: Schema.Any,
  },
  SyncedProjects: {
    data: Schema.Option(Schema.Any),
    details: Schema.Any,
  },
  ChangedTextFilter: { value: Schema.String },
  ClickedOpenFilter: {},
  ChangedSortField: { field: Schema.String },
  ClickedSortDirection: {},
  ClickedNewIssue: {},
  ClickedCancelCompose: {},
  ChangedComposerTitle: { value: Schema.String },
  ChangedComposerDescription: { value: Schema.String },
  ClickedCreateIssue: {},
  CompletedCreateIssue: { result: Schema.Any },
  FailedCreateIssue: { error: Schema.String },
})
export type Message = typeof Message.Type

// INIT

export const init = (
  projectName: string,
  maybeLogin: Option.Option<Login>,
): Update.Return<Model, Message, ZeroService> => ({
  model: {
    projectName,
    maybeLogin: maybeLogin as Model['maybeLogin'],
    maybeIssues: Option.none(),
    maybeProjects: Option.none(),
    resultType: 'unknown',
    textFilter: '',
    open: 'All',
    sortField: 'modified',
    sortDirection: 'desc',
    isComposing: false,
    composerTitle: '',
    composerDescription: '',
  },
})

// ZERO BINDING

const bound = ZeroClient.bind<Model>(model =>
  Option.some(zeroOptions(model.maybeLogin as Option.Option<Login>)),
)

const openToParam = (open: OpenFilter): boolean | null =>
  open === 'Open' ? true : open === 'Closed' ? false : null

const listContextOf = (model: Model) => ({
  open: openToParam(model.open),
  projectName: model.projectName.toLowerCase(),
  assignee: null,
  creator: null,
  labels: null,
  textFilter: model.textFilter === '' ? null : model.textFilter,
  sortField: model.sortField,
  sortDirection: model.sortDirection,
})

// SUBSCRIPTIONS

export const subscriptions = Subscription.make<Model, Message, ZeroService>()(
  entry => ({
    issues: bound.query(entry, {
      modelToRequest: model =>
        queries.issueListV2({
          listContext: listContextOf(model),
          limit: PAGE_SIZE,
          start: null,
          dir: 'forward',
          inclusive: false,
        }),
      toMessage: (data, details) =>
        Message.SyncedIssues({
          data: Option.fromNullishOr(data),
          details,
        }),
      ttl: 'forever',
    }),
    projects: bound.query(entry, {
      modelToRequest: () => queries.allProjects(),
      toMessage: (data, details) =>
        Message.SyncedProjects({
          data: Option.fromNullishOr(data),
          details,
        }),
      ttl: 'forever',
    }),
  }),
)

// COMMANDS

export const CreateIssue = Command.define('CreateIssue', {
  args: {
    title: Schema.String,
    description: Schema.String,
    maybeProject: Schema.Option(Schema.Any),
  },
  messages: [Message.CompletedCreateIssue, Message.FailedCreateIssue],
  execute: ({ title, description, maybeProject }) =>
    Option.match(maybeProject, {
      onNone: () =>
        Effect.succeed(
          Message.FailedCreateIssue({
            error: 'Project has not synced yet',
          }),
        ),
      onSome: project =>
        ZeroClient.mutate(
          mutators.issue.create({
            id: nanoid(),
            title,
            description: description === '' ? undefined : description,
            created: Date.now(),
            modified: Date.now(),
            projectID: (project as { id: string }).id,
          }),
        ).pipe(
          Effect.map(result => Message.CompletedCreateIssue({ result })),
          Effect.catch(error =>
            Effect.succeed(Message.FailedCreateIssue({ error: String(error) })),
          ),
        ),
    }),
})

// UPDATE

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message, ZeroService>>(message, {
    SyncedIssues: ({ data, details }) => ({
      model: modifyFields(model, {
        maybeIssues: () => data as Model['maybeIssues'],
        resultType: () => details.type,
      }),
    }),

    SyncedProjects: ({ data }) => ({
      model: modifyFields(model, {
        maybeProjects: () => data as Model['maybeProjects'],
      }),
    }),

    ChangedTextFilter: ({ value }) => ({
      model: modifyFields(model, {
        textFilter: () => value,
      }),
    }),

    ClickedOpenFilter: () => ({
      model: modifyFields(model, {
        open: () =>
          model.open === 'All'
            ? 'Open'
            : model.open === 'Open'
              ? 'Closed'
              : 'All',
      }),
    }),

    ChangedSortField: ({ field }) => ({
      model: modifyFields(model, {
        sortField: () => field as SortField,
      }),
    }),

    ClickedSortDirection: () => ({
      model: modifyFields(model, {
        sortDirection: () => (model.sortDirection === 'asc' ? 'desc' : 'asc'),
      }),
    }),

    ClickedNewIssue: () => ({
      model: modifyFields(model, {
        isComposing: () => true,
      }),
    }),

    ClickedCancelCompose: () => ({
      model: modifyFields(model, {
        isComposing: () => false,
        composerTitle: () => '',
        composerDescription: () => '',
      }),
    }),

    ChangedComposerTitle: ({ value }) => ({
      model: modifyFields(model, {
        composerTitle: () => value,
      }),
    }),

    ChangedComposerDescription: ({ value }) => ({
      model: modifyFields(model, {
        composerDescription: () => value,
      }),
    }),

    ClickedCreateIssue: () => ({
      model: modifyFields(model, {
        isComposing: () => false,
        composerTitle: () => '',
        composerDescription: () => '',
      }),
      commands: [
        CreateIssue({
          title: model.composerTitle,
          description: model.composerDescription,
          maybeProject: Option.flatMap(model.maybeProjects, projects =>
            Option.fromNullishOr(
              projects.find(
                p =>
                  (p as { name?: string }).name?.toLowerCase() ===
                  model.projectName.toLowerCase(),
              ),
            ),
          ),
        }),
      ],
    }),

    CompletedCreateIssue: () => ({ model }),
    FailedCreateIssue: () => ({ model }),
  })

// VIEW

const relativeTime = (timestamp: number): string => {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

const issueHref = (model: Model, issue: Issue): string =>
  routeToUrlPath(
    AppRoute.Issue({
      projectName: model.projectName,
      id: String(issue.shortID ?? issue.id),
    }),
  )

export const view = Submodel.defineView<Model, Message>(
  (model, h): Html => {
    const inputClass =
      'px-3 py-2 rounded border border-gray-700 bg-gray-900 text-gray-100'

    const toolbar = h.div(
      [h.Class('flex items-center gap-3 mb-4 flex-wrap')],
      [
        h.input([
          h.Class(`${inputClass} w-64`),
          h.Value(model.textFilter),
          h.Placeholder('Filter issues...'),
          h.OnInput(value => Message.ChangedTextFilter({ value })),
        ]),
        h.button(
          [
            h.Class(`${inputClass} bg-gray-800`),
            h.OnClick(Message.ClickedOpenFilter()),
          ],
          [`Status: ${model.open.toLowerCase()}`],
        ),
        h.select(
          [
            h.Class(`${inputClass} bg-gray-800`),
            h.Value(model.sortField),
            h.OnInput(value => Message.ChangedSortField({ field: value })),
          ],
          [
            h.option([h.Value('modified')], ['Modified']),
            h.option([h.Value('created')], ['Created']),
          ],
        ),
        h.button(
          [
            h.Class(`${inputClass} bg-gray-800`),
            h.OnClick(Message.ClickedSortDirection()),
          ],
          [model.sortDirection === 'asc' ? 'Sort ↑' : 'Sort ↓'],
        ),
        ...(Option.isSome(model.maybeLogin)
          ? [
              h.button(
                [
                  h.Class(
                    'px-3 py-2 rounded bg-blue-600 text-white hover:bg-blue-500',
                  ),
                  h.OnClick(Message.ClickedNewIssue()),
                ],
                ['+ New Issue'],
              ),
            ]
          : []),
      ],
    )

    const composer = model.isComposing
      ? h.div(
          [h.Class('mb-4 p-4 rounded border border-gray-700 bg-gray-900')],
          [
            h.input([
              h.Class(`${inputClass} block w-full mb-2 bg-gray-800`),
              h.Value(model.composerTitle),
              h.Placeholder('Issue title'),
              h.OnInput(value => Message.ChangedComposerTitle({ value })),
            ]),
            h.textarea([
              h.Class(`${inputClass} block w-full mb-2 bg-gray-800`),
              h.Value(model.composerDescription),
              h.Placeholder('Description (markdown)'),
              h.OnInput(value =>
                Message.ChangedComposerDescription({ value }),
              ),
            ]),
            h.div([h.Class('flex gap-2')], [
              h.button(
                [
                  h.Class(
                    'px-3 py-2 rounded bg-blue-600 text-white hover:bg-blue-500',
                  ),
                  h.OnClick(Message.ClickedCreateIssue()),
                ],
                ['Create Issue'],
              ),
              h.button(
                [
                  h.Class(`${inputClass} bg-gray-800`),
                  h.OnClick(Message.ClickedCancelCompose()),
                ],
                ['Cancel'],
              ),
            ]),
          ],
        )
      : h.div([h.Class('hidden')], [])

    const row = (issue: Issue): Html =>
      h.a(
        [
          h.Class(
            'flex items-baseline gap-3 py-2 px-2 border-b border-gray-800 hover:bg-gray-900 cursor-pointer',
          ),
          h.Href(issueHref(model, issue)),
        ],
        [
          h.span(
            [h.Class('w-10 text-gray-400 text-sm text-right shrink-0')],
            [String(issue.shortID ?? '—')],
          ),
          h.span(
            [
              h.Class(
                issue.open
                  ? 'text-green-400 shrink-0'
                  : 'text-purple-400 shrink-0',
              ),
            ],
            [issue.open ? '●' : '◐'],
          ),
          h.span([h.Class('text-gray-100')], [issue.title]),
          ...(issue.labels ?? []).map(label =>
            h.span(
              [
                h.Class(
                  'px-2 py-0.5 rounded text-xs bg-gray-800 text-gray-300 border border-gray-700 shrink-0',
                ),
              ],
              [label.name],
            ),
          ),
          h.span([h.Class('flex-1')], []),
          h.span(
            [h.Class('text-gray-400 text-sm shrink-0')],
            [
              `${issue.creator?.login ?? ''} · ${relativeTime(issue.modified)}`,
            ],
          ),
          h.span(
            [h.Class('flex gap-1 shrink-0')],
            issue.labels.map(
              (
                label: {
                  readonly id: string
                  readonly name: string
                },
              ) =>
                h.span(
                  [
                    h.Class(
                      'bg-gray-700 text-gray-300 text-xs rounded px-1.5 py-0.5',
                    ),
                  ],
                  [label.name],
                ),
            ),
          ),
        ],
      )

    const listBody = Option.match(model.maybeIssues, {
      onNone: () =>
        h.div(
          [h.Class('text-gray-400 py-8 text-center')],
          [
            model.resultType === 'error'
              ? 'Failed to load issues'
              : 'Loading issues…',
          ],
        ),
      onSome: issues =>
        (issues as ReadonlyArray<Issue>).length === 0
          ? h.div(
              [h.Class('text-gray-400 py-8 text-center')],
              ['No issues found'],
            )
          : h.div(
              [h.Class('flex flex-col')],
              (issues as ReadonlyArray<Issue>).map(row),
            ),
    })

    return h.div(
      [h.Class('flex flex-col')],
      [toolbar, composer, listBody],
    )
  },
)
