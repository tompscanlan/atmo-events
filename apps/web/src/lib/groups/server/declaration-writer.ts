// Publishing and withdrawing a group's `declaration`, its one anonymously
// readable record.
//
// The transport, credential and permission check are the event gate's
// (`groupWriter` and `requireGroupPermission` in ./event-writer.ts). Unlike
// ./about-writer.ts, the target is the group's public repo, not a space:
// `GroupRepoWrite.space` is left unset, so the write goes through
// com.atproto.repo.*, as a group event does. And the record is conditional. A
// private group must not have one, so a group that turns private has its
// declaration deleted, not just left alone. Presence or absence is the only
// thing an anonymous peer can see about a group, and a stale declaration would
// keep announcing a group that asked not to be announced.
//
// The permission is always MANAGE_GROUP: announcing the group changes the
// group's own face, as writing its profile does.
//
// A WITHDRAWAL TELLS OUR OWN INDEX; A DECLARE NEVER DOES. Browse lists whatever
// the declaration index holds, so a group that turns private must leave the
// index when its declaration leaves the repo, not a cron tick later. The index
// learns of it through `notifyOfUpdate`, which re-reads the URI from the
// group's PDS and deletes its entry when no record comes back. It deletes on
// any answer that is not a record, a 5xx included, so the same call after a
// declare would drop a live declaration whenever the PDS blinked, and nothing
// would restore it until the group's next write. A declaration that was just
// written reaches the index from Jetstream instead.
import {
	GROUP_DECLARATION_COLLECTION,
	GROUP_DECLARATION_RKEY,
	declarationRequired,
	groupDeclarationRecord
} from '../declaration-record';
import type { GroupRow } from '../types';
import type { GroupSpaceReader } from './about-read';
import type { CredentialStoreEnv } from './credentials';
import {
	GroupRecordError,
	groupWriter,
	requireGroupPermission,
	type GroupRepoWriter
} from './event-writer';
import { contrailNotifier, type GroupEventNotifier } from './events-index';

export interface WriteGroupDeclarationInput {
	db: D1Database;
	env: CredentialStoreEnv;
	group: GroupRow;
	/** The human pressing the button. Checked, never written as. */
	callerDid: string | null;
	/** Carried across a rewrite so a group that flips private and back does not
	 *  claim it was declared today. */
	createdAt?: string | null;
	/** Overrides the PDS transport. When absent, it is built from the group's
	 *  stored credential. */
	writer?: GroupRepoWriter;
	/** Overrides the members-space reader the gate resolves from. */
	reader?: GroupSpaceReader | null;
}

/** A withdrawal's input. Only a withdrawal takes a notifier:
 *  `writeGroupDeclaration` has none to call. */
export interface WithdrawGroupDeclarationInput extends WriteGroupDeclarationInput {
	/** Overrides the index notification. Tests pass this; nothing else should,
	 *  because a caller that supplies its own is a caller that can forget. */
	notify?: GroupEventNotifier;
}

export interface DeclarationWriteResult {
	uri: string;
	cid: string;
}

/** The space the declaration points to, read off the row rather than
 *  recomputed.
 *
 *  A NULL here is a real state (a group whose provisioning did not finish), and
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
 *  (for example after it flips back from private) must overwrite rather than
 *  fail on a record that is already there. */
export async function writeGroupDeclaration(
	input: WriteGroupDeclarationInput
): Promise<DeclarationWriteResult> {
	await requireGroupPermission(input, 'MANAGE_GROUP');

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

/** Withdraws the declaration, then tells our own index it is gone.
 *
 *  Safe to call when there is none: the reference PDS treats deleting a missing
 *  record as a no-op rather than an error, so this needs no read first and no
 *  "did it exist" branch that could disagree with the repo. The index is told
 *  either way, which is harmless: it deletes only an entry it holds.
 *
 *  The index is told only after the PDS has accepted the delete. A delete that
 *  fails throws before it, so the index never drops a declaration the repo
 *  still holds. */
export async function removeGroupDeclaration(input: WithdrawGroupDeclarationInput): Promise<void> {
	await requireGroupPermission(input, 'MANAGE_GROUP');

	const writer = input.writer ?? (await groupWriter(input.env, input.db, input.group));
	await writer({
		repo: input.group.group_did,
		collection: GROUP_DECLARATION_COLLECTION,
		rkey: GROUP_DECLARATION_RKEY,
		record: {},
		intent: 'delete'
	});

	await forgetDeclaration(input);
}

/** Tells our own index that the group's declaration is gone.
 *
 *  A failure is logged and swallowed. The PDS has already deleted the record,
 *  so the save did what it was asked to, and a dead index means browse lists
 *  the group until the next cron tick carries the delete in from Jetstream.
 *  Reporting it as a failed save would be untrue and would invite a retry of a
 *  delete that landed. */
async function forgetDeclaration(input: WithdrawGroupDeclarationInput): Promise<void> {
	const uri = `at://${input.group.group_did}/${GROUP_DECLARATION_COLLECTION}/${GROUP_DECLARATION_RKEY}`;
	try {
		await (input.notify ?? contrailNotifier(input.db))(uri);
	} catch (e) {
		console.error(`[groups] could not tell the index that ${uri} was withdrawn:`, e);
	}
}

/**
 * Brings the network's view of this group into line with its visibility: a
 * public group is declared, a private one is not.
 *
 * One function decides, rather than a visibility check at each call site, so
 * a change to which groups get a declaration only touches
 * `declarationRequired`.
 *
 * `assumeAbsent` is for the create path: a repo minted seconds ago cannot hold
 * a declaration, so a private group's create skips a delete that can only be a
 * no-op, and that could otherwise fail a group that was just created.
 */
export async function reconcileGroupDeclaration(
	input: WithdrawGroupDeclarationInput & { assumeAbsent?: boolean }
): Promise<DeclarationWriteResult | null> {
	// `writeGroupDeclaration` takes no notifier, so `input.notify` goes no
	// further on this branch: a declare must never tell the index (see the file
	// header).
	if (declarationRequired(input.group)) return writeGroupDeclaration(input);
	if (input.assumeAbsent) return null;
	await removeGroupDeclaration(input);
	return null;
}
