import { Command, Submodel, Subscription, type Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { modifyFields } from 'foldkit/struct'
import { Effect, Option, Schema } from 'effect'
import { nanoid } from 'nanoid'
import type { QueryResultType } from '@rocicorp/zero'
import { mutators } from '../../shared/mutators.ts'
import { queries } from '../../shared/queries.ts'
import { getIDFromString } from '../../shared/issue-id.ts'
import type { Login } from '../auth.ts'
import { AppRoute, routeToUrlPath } from '../route.ts'
import { ZeroClient, type ZeroService, zeroOptions } from '../zero.ts'

type IssueDetail = QueryResultType<typeof queries.issueDetail>
type Comment = NonNullable<IssueDetail>['comments'][number]

// MODEL

export const Model = Schema.Struct({
  projectName: Schema.String,
  id: Schema.String,
  maybeLogin: Schema.Option(
    Schema.Struct({ encoded: Schema.String, decoded: Schema.Any }),
  ),
  maybeIssue: Schema.Option(Schema.Any),
  resultType: Schema.String,
  commentDraft: Schema.String,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  SyncedIssueDetail: {
    data: Schema.Option(Schema.Any),
    details: Schema.Any,
  },
  ChangedCommentDraft: { value: Schema.String },
  ClickedSubmitComment: {},
  CompletedAddComment: { result: Schema.Any },
  FailedAddComment: { error: Schema.String },
  ClickedToggleOpen: {},
  CompletedUpdateIssue: { result: Schema.Any },
  FailedUpdateIssue: { error: Schema.String },
})
export type Message = typeof Message.Type

// INIT

export const init = (
  projectName: string,
  id: string,
  maybeLogin: Option.Option<Login>,
): Update.Return<Model, Message, ZeroService> => ({
  model: {
    projectName,
    id,
    maybeLogin: maybeLogin as Model['maybeLogin'],
    maybeIssue: Option.none(),
    resultType: 'unknown',
    commentDraft: '',
  },
})

// ZERO BINDING

const bound = ZeroClient.bind<Model>(model =>
  Option.some(zeroOptions(model.maybeLogin as Option.Option<Login>)),
)

const issueRequest = (model: Model) => {
  const { idField, idValue } = getIDFromString(model.id)
  return queries.issueDetail({ idField, id: idValue })
}

// SUBSCRIPTIONS

export const subscriptions = Subscription.make<Model, Message, ZeroService>()(
  entry => ({
    issue: bound.query(entry, {
      modelToRequest: issueRequest,
      toMessage: (data, details) =>
        Message.SyncedIssueDetail({
          data: Option.fromNullishOr(data),
          details,
        }),
      ttl: 'forever',
    }),
  }),
)

// COMMANDS

export const AddComment = Command.define('AddComment', {
  args: { issueID: Schema.String, body: Schema.String },
  messages: [Message.CompletedAddComment, Message.FailedAddComment],
  execute: ({ issueID, body }) =>
    ZeroClient.mutate(
      mutators.comment.add({
        id: nanoid(),
        issueID,
        body,
        created: Date.now(),
      }),
    ).pipe(
      Effect.map(result => Message.CompletedAddComment({ result })),
      Effect.catch(error =>
        Effect.succeed(Message.FailedAddComment({ error: String(error) })),
      ),
    ),
})

export const ToggleOpen = Command.define('ToggleOpen', {
  args: { id: Schema.String, open: Schema.Boolean },
  messages: [Message.CompletedUpdateIssue, Message.FailedUpdateIssue],
  execute: ({ id, open }) =>
    ZeroClient.mutate(
      mutators.issue.update({
        id,
        open,
        modified: Date.now(),
      }),
    ).pipe(
      Effect.map(result => Message.CompletedUpdateIssue({ result })),
      Effect.catch(error =>
        Effect.succeed(Message.FailedUpdateIssue({ error: String(error) })),
      ),
    ),
})

// UPDATE

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message, ZeroService>>(message, {
    SyncedIssueDetail: ({ data, details }) => ({
      model: modifyFields(model, {
        maybeIssue: () => data as Model['maybeIssue'],
        resultType: () => details.type,
      }),
    }),

    ChangedCommentDraft: ({ value }) => ({
      model: modifyFields(model, {
        commentDraft: () => value,
      }),
    }),

    ClickedSubmitComment: () =>
      Option.match(model.maybeIssue, {
        onNone: () => ({ model }),
        onSome: issue =>
          model.commentDraft.trim() === ''
            ? { model }
            : {
                model: modifyFields(model, {
                  commentDraft: () => '',
                }),
                commands: [
                  AddComment({
                    issueID: (issue as IssueDetail & { id: string }).id,
                    body: model.commentDraft,
                  }),
                ],
              },
      }),

    CompletedAddComment: () => ({ model }),
    FailedAddComment: () => ({ model }),

    ClickedToggleOpen: () =>
      Option.match(model.maybeIssue, {
        onNone: () => ({ model }),
        onSome: issue => {
          const detail = issue as IssueDetail & { id: string; open: boolean }
          return {
            model,
            commands: [
              ToggleOpen({ id: detail.id, open: !detail.open }),
            ],
          }
        },
      }),

    CompletedUpdateIssue: () => ({ model }),
    FailedUpdateIssue: () => ({ model }),
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
  return `${Math.floor(days / 30)}mo ago`
}

const commentCard = (comment: Comment, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('rounded border border-gray-800 bg-gray-900 p-4')],
    [
      h.div([h.Class('flex items-center gap-2 mb-2')], [
        h.span(
          [h.Class('text-gray-100 font-medium text-sm')],
          [comment.creator?.login ?? 'unknown'],
        ),
        h.span(
          [h.Class('text-gray-500 text-xs')],
          [relativeTime(comment.created)],
        ),
      ]),
      h.div(
        [h.Class('text-gray-200 whitespace-pre-wrap text-sm')],
        [comment.body],
      ),
    ],
  )

export const view = Submodel.defineView<Model, Message>(
  (model, h): Html => {
    const backHref = routeToUrlPath(
      AppRoute.List({ projectName: model.projectName }),
    )

    return Option.match(model.maybeIssue, {
      onNone: () =>
        h.div([h.Class('text-gray-400 py-8 text-center')], [
          model.resultType === 'complete' || model.resultType === 'error'
            ? 'Issue not found'
            : 'Loading issue…',
        ]),
      onSome: rawIssue => {
        const issue = rawIssue as IssueDetail & {
          id: string
          title: string
          description: string
          open: boolean
          created: number
          modified: number
          comments: ReadonlyArray<Comment>
          labels?: ReadonlyArray<{ name: string }>
          creator?: { login: string } | null
          assignee?: { login: string } | null
          canEdit?: boolean
        }
        const comments = [...issue.comments].reverse()

        return h.div([h.Class('flex flex-col gap-4')], [
          h.a(
            [
              h.Class('text-blue-400 hover:text-blue-300 text-sm'),
              h.Href(backHref),
            ],
            ['← Back to issues'],
          ),

          h.div(
            [
              h.Class(
                'rounded border border-gray-800 bg-gray-900 p-5',
              ),
            ],
            [
              h.div([h.Class('flex items-center gap-3 mb-3')], [
                h.span(
                  [
                    h.Class(
                      issue.open ? 'text-green-400' : 'text-purple-400',
                    ),
                  ],
                  [issue.open ? '● Open' : '◐ Closed'],
                ),
                h.span(
                  [h.Class('text-gray-100 text-xl font-semibold')],
                  [issue.title],
                ),
                h.span([h.Class('flex-1')], []),
                ...(Option.isSome(model.maybeLogin)
                  ? [
                      h.button(
                        [
                          h.Class(
                            'px-3 py-1.5 rounded border border-gray-700 bg-gray-800 text-gray-100 text-sm',
                          ),
                          h.OnClick(Message.ClickedToggleOpen()),
                        ],
                        [issue.open ? 'Close issue' : 'Reopen issue'],
                      ),
                    ]
                  : []),
              ]),
              h.div(
                [h.Class('text-gray-500 text-sm mb-3 flex gap-4')],
                [
                  h.span([], [`#${issue.id.slice(0, 8)}`]),
                  h.span([], [
                    `opened by ${issue.creator?.login ?? 'unknown'}`,
                  ]),
                  h.span([], [relativeTime(issue.created)]),
                  ...(issue.assignee
                    ? [h.span([], [`assigned to ${issue.assignee.login}`])]
                    : []),
                  ...(issue.labels ?? []).map(label =>
                    h.span(
                      [
                        h.Class(
                          'px-2 py-0.5 rounded text-xs bg-gray-800 text-gray-300 border border-gray-700',
                        ),
                      ],
                      [label.name],
                    ),
                  ),
                ],
              ),
              h.div(
                [h.Class('text-gray-200 whitespace-pre-wrap')],
                [issue.description === '' ? 'No description.' : issue.description],
              ),
            ],
          ),

          h.h3(
            [h.Class('text-gray-100 font-semibold mt-2')],
            [`Comments (${issue.comments.length})`],
          ),
          ...comments.map(comment => commentCard(comment, h)),

          ...(Option.isSome(model.maybeLogin)
            ? [
                h.div([h.Class('flex flex-col gap-2 mt-2')], [
                  h.textarea([
                    h.Class(
                      'w-full px-3 py-2 rounded border border-gray-700 bg-gray-900 text-gray-100',
                    ),
                    h.Value(model.commentDraft),
                    h.Placeholder('Write a comment...'),
                    h.OnInput(value =>
                      Message.ChangedCommentDraft({ value }),
                    ),
                  ]),
                  h.div([], [
                    h.button(
                      [
                        h.Class(
                          'px-4 py-2 rounded bg-blue-600 text-white hover:bg-blue-500',
                        ),
                        h.OnClick(Message.ClickedSubmitComment()),
                      ],
                      ['Comment'],
                    ),
                  ]),
                ]),
              ]
            : []),
        ])
      },
    })
  },
)
