import {Effect, Result} from 'effect';
import {HttpRouter} from 'effect/unstable/http';
import {HttpServerRequest} from 'effect/unstable/http';
import {HttpServerResponse} from 'effect/unstable/http';
import type {JWTData, Role} from '../shared/auth.ts';
import {getIDFromString} from '../shared/issue-id.ts';
import {applyIssuePermissions} from '../shared/queries.ts';
import {builder} from '../shared/schema.ts';
import type {dbProvider} from './db.ts';
import {issueMdPath, renderErrorMd, renderIssueMd} from './machine-md.ts';

/**
 * The markdown view caps huge (synthetic) threads at the most recent comments
 * rather than rendering unboundedly.
 */
const MAX_COMMENTS = 1000;

type DbProvider = ReturnType<typeof dbProvider>;

type AuthFn = (
  headers: Record<string, string | string[] | undefined>,
) => Promise<JWTData | undefined>;

// Returns undefined for ids that cannot possibly match (empty, or digit
// strings beyond the safe-integer range).
function parseIssueID(idStr: string) {
  if (idStr === '') {
    return undefined;
  }
  const parsed = getIDFromString(idStr);
  return parsed.idField === 'shortID' && !Number.isSafeInteger(parsed.idValue)
    ? undefined
    : parsed;
}

// The issue tree the markdown view renders. This is issueDetail minus the
// per-user relationships (viewState, notificationState) and the comment
// preload: the markdown view has no per-user state, and comments are fetched
// separately below. Uses the same applyIssuePermissions gate as issueDetail.
export function issueForMdQuery(
  idField: 'shortID' | 'id',
  idValue: string | number,
  role: Role | undefined,
) {
  return applyIssuePermissions(
    builder.issue
      .where(idField, idValue)
      .related('project')
      .related('creator')
      .related('assignee')
      .related('labels')
      .related('emoji', e => e.related('creator')),
    role,
  ).one();
}

function fetchIssueForMd(
  dbProvider: DbProvider,
  authData: JWTData | undefined,
  idField: 'shortID' | 'id',
  idValue: string | number,
) {
  return dbProvider.transaction(async tx => {
    const issue = await tx.run(
      issueForMdQuery(idField, idValue, authData?.role),
    );
    if (!issue) {
      return undefined;
    }
    // The full thread rather than issueDetail's 50-comment preload. This
    // query has no visibility gate of its own, which is safe only because it
    // runs after the permission-gated issueDetail query above returned the
    // issue, and never for a synced query.
    const commentsDesc = await tx.run(
      builder.comment
        .where('issueID', issue.id)
        .orderBy('created', 'desc')
        .orderBy('id', 'desc')
        .related('creator')
        .related('emoji', e => e.related('creator'))
        .limit(MAX_COMMENTS),
    );
    return {
      issue,
      comments: commentsDesc.toReversed(),
      commentsCapped: commentsDesc.length === MAX_COMMENTS,
    };
  });
}

const sendMarkdown = (body: string, status = 200) =>
  HttpServerResponse.text(body, {
    status,
    contentType: 'text/markdown; charset=utf-8',
  });

/**
 * Registers the machine-readable markdown view of an issue
 * (`/p/:projectName/issue/:id.md`) for crawlers and AI agents that cannot run
 * the synced SPA.
 */
export const machineRoutes = (
  dbProvider: DbProvider,
  auth: AuthFn,
) =>
  HttpRouter.route(
    'GET',
    '/p/:projectName/issue/:id.md',
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const params = yield* HttpRouter.params;
      const projectName = params['projectName'] ?? '';
      const idParam = params['id'] ?? '';

      const hasAuthHeader = request.headers['authorization'] !== undefined;

      const authResult = yield* Effect.result(
        Effect.tryPromise(() =>
          auth(request.headers as Record<string, string | undefined>),
        ),
      );
      if (Result.isFailure(authResult)) {
        return HttpServerResponse.setHeader(
          sendMarkdown(
            renderErrorMd(
              'Unauthorized',
              authResult.failure instanceof Error
                ? authResult.failure.message
                : 'Invalid authorization header.',
            ),
            401,
          ),
          'cache-control',
          'private, no-store',
        );
      }
      const authData = authResult.success;

      const parsed = parseIssueID(idParam);
      const result =
        parsed &&
        (yield* Effect.tryPromise(() =>
          fetchIssueForMd(dbProvider, authData, parsed.idField, parsed.idValue),
        ).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        ));

      const cacheControl = (directives: string) =>
        hasAuthHeader ? 'private, no-store' : `public, ${directives}`;

      if (!result) {
        return HttpServerResponse.setHeader(
          sendMarkdown(
            renderErrorMd(
              'Not Found',
              'No such issue, or you do not have permission to view it.',
            ),
            404,
          ),
          'cache-control',
          cacheControl('s-maxage=60'),
        );
      }

      const {issue, comments, commentsCapped} = result;
      if (issue.project) {
        const ref = String(issue.shortID ?? issue.id);
        if (
          projectName.toLowerCase() !== issue.project.lowerCaseName ||
          idParam !== ref
        ) {
          return HttpServerResponse.setHeader(
            HttpServerResponse.redirect(
              issueMdPath(issue.project.lowerCaseName, ref),
              {status: 308},
            ),
            'cache-control',
            cacheControl('s-maxage=300'),
          );
        }
      }

      return HttpServerResponse.setHeader(
        sendMarkdown(renderIssueMd(issue, comments, {commentsCapped})),
        'cache-control',
        cacheControl('s-maxage=300, stale-while-revalidate=3600'),
      );
    }),
  );
