import type {Query, Transaction} from '@rocicorp/zero';
import * as z from 'zod/mini';
import {MutationError, MutationErrorCode} from './error.ts';
import {builder, type schema} from './schema.ts';
import {must} from './util.ts';

/** The contents of the zbugs JWT */
export const jwtDataSchema = z.object({
  sub: z.string(),
  role: z.union([z.literal('crew'), z.literal('user')]),
  name: z.string(),
  iat: z.number(),
  exp: z.number(),
});

export type JWTData = z.infer<typeof jwtDataSchema>;

export type AuthData = Pick<JWTData, 'sub' | 'role'>;
export type Role = AuthData['role'];

export function assertIsLoggedIn(
  authData: AuthData | undefined,
): asserts authData {
  if (!authData) {
    throw new MutationError(
      'User must be logged in for this operation',
      MutationErrorCode.NOT_LOGGED_IN,
    );
  }
}

export function isAdmin(token: AuthData | undefined) {
  assertIsLoggedIn(token);
  return token.role === 'crew';
}

export async function assertIsCreatorOrAdmin(
  tx: Transaction,
  authData: AuthData | undefined,
  query: Query<'comment' | 'issue' | 'emoji'>,
  id: string,
) {
  assertIsLoggedIn(authData);
  if (isAdmin(authData)) {
    return;
  }
  const entity = await tx.run(query.where('id', id).one());
  // Security: Use generic error message to avoid leaking entity existence
  if (!entity) {
    throw new MutationError(
      `Not authorized to access this resource`,
      MutationErrorCode.NOT_AUTHORIZED,
      id,
    );
  }
  if (authData.sub !== entity.creatorID) {
    throw new MutationError(
      `Not authorized to access this resource`,
      MutationErrorCode.NOT_AUTHORIZED,
      id,
    );
  }
}

export async function assertUserCanSeeIssue(
  tx: Transaction<typeof schema, unknown>,
  userID: string,
  issueID: string,
) {
  const issue = must(await tx.run(builder.issue.where('id', issueID).one()));
  const user = must(await tx.run(builder.user.where('id', userID).one()));

  if (
    issue.visibility !== 'public' &&
    userID !== issue.creatorID &&
    user.role !== 'crew'
  ) {
    throw new MutationError(
      'User does not have permission to view this issue',
      MutationErrorCode.NOT_AUTHORIZED,
      issueID,
    );
  }
}

export async function assertUserCanSeeComment(
  tx: Transaction<typeof schema, unknown>,
  userID: string,
  commentID: string,
) {
  const comment = must(
    await tx.run(builder.comment.where('id', commentID).one()),
  );

  await assertUserCanSeeIssue(tx, userID, comment.issueID);
}

declare module '@rocicorp/zero' {
  interface DefaultTypes {
    context: AuthData | undefined;
  }
}
