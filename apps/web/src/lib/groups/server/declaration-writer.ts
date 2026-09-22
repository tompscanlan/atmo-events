// Publishing — and withdrawing — a group's one anonymously readable record.
//
// The transport, the credential and the permission check are the event gate's,
// unchanged: `groupWriter` and `requireGroupPermission` from ./event-writer.ts.
// Two things are different from ../about-writer.ts, and only two:
//
//   * the target is the group's PUBLIC REPO, not a space. `GroupRepoWrite.space`
//     is left unset, which routes the write through com.atproto.repo.* instead
//     of com.atproto.space.* — the same branch a group event takes.
//   * the record is CONDITIONAL. A private group must not have one, so a group
//     that turns private has its declaration deleted rather than merely not
//     rewritten: presence or absence is the only thing an anonymous peer can
//     observe about a group, so leaving a stale pointer behind would keep
//     announcing a group that has asked not to be announced.
//
// Permission is MANAGE_GROUP, always — announcing the group to the network is
// changing the group's own face, so there is no intent to map, exactly as
// writing the profile has none. (Spec: FR-003.)
import {
	GROUP_DECLARATION_COLLECTION,
	GROUP_DECLARATION_RKEY,
	declarationRequired,
	groupDeclarationRecord
} from '../declaration-record';
import type { GroupRow } from '../types';
import type { CredentialStoreEnv } from './credentials';
import {
	GroupRecordError,
	groupWriter,
	requireGroupPermission,
	type GroupRepoWriter
} from './event-writer';

export interface WriteGroupDeclarationInput {
	db: D1Database;
	env: CredentialStoreEnv;
	group: GroupRow;
	/** The human pressing the button. Checked, never written as. */
	callerDid: string | null;
	/** Carried across a rewrite so a group that flips private and back does not
	 *  claim it was declared today. */
	createdAt?: string | null;
	/** Overrides the PDS transport. Tests and the live probe pass this. */
	writer?: GroupRepoWriter;
}

export interface DeclarationWriteResult {
	uri: string;
	cid: string;
}

/** The space the pointer resolves to, off the row rather than recomputed.
 *
 *  A NULL here is a real state — a group whose provisioning did not finish — and
 *  a declaration pointing at a URI the PDS has never heard of is worse than no
 *  declaration: it is a public promise that resolves to nothing. */
function aboutSpace(group: GroupRow): string {
	if (!group.about_space_uri) {
		throw new GroupRecordError(
			`${group.group_did} has no about space yet, so it cannot be declared to the network`
		);
	}
	return group.about_space_uri;
}

/** Writes the `declaration` into the group's public repo, keyed `self`.
 *
 *  A put rather than a create: `self` is a singleton, so re-declaring a group
 *  (a rename of the space, a flip back from private) must overwrite rather than
 *  fail on a record that is already there. */
export async function writeGroupDeclaration(
	input: WriteGroupDeclarationInput
): Promise<DeclarationWriteResult> {
	await requireGroupPermission(input.db, input.group, input.callerDid, 'MANAGE_GROUP');

	const record = {
		...groupDeclarationRecord({
			aboutSpaceUri: aboutSpace(input.group),
			createdAt: input.createdAt
		}),
		$type: GROUP_DECLARATION_COLLECTION
	};

	const writer = input.writer ?? (await groupWriter(input.env, input.db, input.group));
	const result = await writer({
		repo: input.group.group_did,
		collection: GROUP_DECLARATION_COLLECTION,
		rkey: GROUP_DECLARATION_RKEY,
		record,
		intent: 'update'
		// No `space`: this is the one group record the anonymous web must read.
	});
	return { uri: result.uri, cid: result.cid };
}

/** Withdraws the declaration.
 *
 *  Safe to call when there is none: the reference PDS treats deleting a missing
 *  record as a no-op rather than an error, so this needs no read first and no
 *  "did it exist" branch that could disagree with the repo. */
export async function removeGroupDeclaration(input: WriteGroupDeclarationInput): Promise<void> {
	await requireGroupPermission(input.db, input.group, input.callerDid, 'MANAGE_GROUP');

	const writer = input.writer ?? (await groupWriter(input.env, input.db, input.group));
	await writer({
		repo: input.group.group_did,
		collection: GROUP_DECLARATION_COLLECTION,
		rkey: GROUP_DECLARATION_RKEY,
		record: {},
		intent: 'delete'
	});
}

/**
 * Brings the network's view of this group into line with its visibility: a
 * public group is declared, a private one is not.
 *
 * ONE function decides, rather than a visibility check at each call site,
 * because "does this group get a declaration" is the clause most likely to
 * change — whether `private` survives as a group-level value at all is an open
 * decision, and when it is answered `declarationRequired` is the only thing
 * that moves.
 *
 * `assumeAbsent` is for the create path: a repo minted seconds ago cannot be
 * holding a declaration, so a private group's create is not charged a delete
 * that can only ever be a no-op — and, more to the point, cannot fail a
 * freshly created group on a call that had nothing to do.
 */
export async function reconcileGroupDeclaration(
	input: WriteGroupDeclarationInput & { assumeAbsent?: boolean }
): Promise<DeclarationWriteResult | null> {
	if (declarationRequired(input.group)) return writeGroupDeclaration(input);
	if (input.assumeAbsent) return null;
	await removeGroupDeclaration(input);
	return null;
}
