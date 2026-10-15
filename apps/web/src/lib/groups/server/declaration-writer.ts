// Publishes and withdraws a group's `declaration`, its one anonymously readable
// record. It lives in the group's public repo, and only a public group has one:
// its presence is all an anonymous peer can see of a group.
//
// A withdrawal tells our own index at once, so browse drops a group that turned
// private, and it fails if the index cannot be told: browse shows a declared
// group's name from the row, so a stale entry would show the text a save going
// private writes next. A declare never tells the index: `notifyOfUpdate` deletes
// the entry on any answer that is not a record, a 5xx included, so it could drop
// a live declaration. Jetstream brings a new declaration in instead.
import {
	GROUP_DECLARATION_COLLECTION,
	GROUP_DECLARATION_RKEY,
	declarationRequired,
	groupDeclarationRecord
} from '../declaration-record';
import { type GroupRow, type GroupVisibility } from '../types';
import type { GroupSpaceReader } from './about-read';

import { notifyIndex } from './events-index';
import { errorText } from './errors';

import { gatedWriter, requireGroupWrite, type GroupRepoWriter, ownSpace } from './group-write';
import { VISIBILITY_WRITE } from '../grants';

const aboutSpace = (group: GroupRow) =>
	ownSpace(group, 'about', group.about_space_uri, 'it cannot be declared to the network');
import { type CredentialStoreEnv, groupClient, requireGroupCredential } from './session';
import { didSpaceHosts, type SpaceHosts } from './space-credential';
import { repoRecordExists, type XrpcHandle } from './xrpc';
export interface WriteGroupDeclarationInput {
	db: D1Database;
	env: CredentialStoreEnv;
	group: GroupRow;
	callerDid: string | null;
	/** Kept across a rewrite, so a group that goes private and back keeps its date. */
	createdAt?: string | null;
	writer?: GroupRepoWriter;
	reader?: GroupSpaceReader | null;
}

export type WithdrawGroupDeclarationInput = WriteGroupDeclarationInput;

export interface DeclarationWriteResult {
	uri: string;
	cid: string;
}

/** Read off the row. A declaration must not point at a space that was never made,
 *  nor at one of another type: the lexicon requires the group's own meta space. */

/** Puts the declaration, keyed `self`, so re-declaring overwrites. No permission set
 *  names the declaration, which follows the about space's `access`, so it takes the
 *  scope that writes that. */
export async function writeGroupDeclaration(
	input: WriteGroupDeclarationInput
): Promise<DeclarationWriteResult> {
	await requireGroupWrite(input, VISIBILITY_WRITE);

	const record = {
		...groupDeclarationRecord({
			aboutSpaceUri: aboutSpace(input.group),
			createdAt: input.createdAt
		}),
		$type: GROUP_DECLARATION_COLLECTION
	};

	const writer = await gatedWriter(input);
	const result = await writer({
		repo: input.group.group_did,
		collection: GROUP_DECLARATION_COLLECTION,
		rkey: GROUP_DECLARATION_RKEY,
		record,
		intent: 'update'
		// No `space`: anonymous readers must reach this record.
	});
	return { uri: result.uri, cid: result.cid };
}

/** The repo no longer holds the group's declaration, but our index could not be
 *  told, so browse may still list the group. Telling it again fixes that. */
export class DeclarationIndexError extends Error {
	constructor(
		readonly groupDid: string,
		readonly cause: unknown
	) {
		super(`this site's index could not drop the declaration: ${errorText(cause)}`);
		this.name = 'DeclarationIndexError';
	}
}

/** Tells our index to look at the group's declaration again, so an entry for one
 *  the repo no longer holds is dropped. Nothing changes when there is none.
 *  Throws `DeclarationIndexError`. */
export async function dropDeclarationFromIndex(db: D1Database, groupDid: string): Promise<void> {
	try {
		await notifyIndex(
			db,
			`at://${groupDid}/${GROUP_DECLARATION_COLLECTION}/${GROUP_DECLARATION_RKEY}`
		);
	} catch (e) {
		throw new DeclarationIndexError(groupDid, e);
	}
}

/** Deletes the declaration, then tells our index. Safe when there is none: the
 *  PDS treats deleting a missing record as a no-op. The index is told only after
 *  the delete lands, so it never drops a declaration the repo still holds. Throws
 *  `DeclarationIndexError` when the index cannot be told, and withdrawing again
 *  tells it again. */
export async function removeGroupDeclaration(input: WithdrawGroupDeclarationInput): Promise<void> {
	await requireGroupWrite(input, VISIBILITY_WRITE);

	const writer = await gatedWriter(input);
	await writer({
		repo: input.group.group_did,
		collection: GROUP_DECLARATION_COLLECTION,
		rkey: GROUP_DECLARATION_RKEY,
		record: {},
		intent: 'delete'
	});

	await dropDeclarationFromIndex(input.db, input.group.group_did);
}

/**
 * Declares a public group and withdraws a private group's declaration.
 * `visibility` is the caller's: the form's on a save, the host's on a repair.
 * `declared`, when the caller knows it, is whether the repo already holds the
 * declaration, so nothing is written that is already so. Unknown, a public
 * group's declaration is put again and a private group's is withdrawn.
 */
export async function reconcileGroupDeclaration(
	input: WithdrawGroupDeclarationInput & { visibility: GroupVisibility; declared?: boolean }
): Promise<DeclarationWriteResult | null> {
	if (declarationRequired(input.visibility)) {
		return input.declared ? null : writeGroupDeclaration(input);
	}
	if (input.declared === false) return null;
	await removeGroupDeclaration(input);
	return null;
}

/** Whether the group's public repo holds its declaration, read through
 *  `personDid`'s own group session. An unreachable PDS throws, so a repair never
 *  acts on a state it could not read. */
export async function groupDeclared(
	env: CredentialStoreEnv,
	groupDid: string,
	personDid: string
): Promise<boolean> {
	const { handle } = await groupClient(
		await requireGroupCredential(env, groupDid, personDid),
		groupDid
	);
	return repoRecordExists(handle, groupDid, GROUP_DECLARATION_COLLECTION, GROUP_DECLARATION_RKEY);
}

/** Whether the group's public repo holds its declaration, read with no session,
 *  as anyone may. A signed-out visitor's gate asks it: no space can be read for
 *  them, and a group publishes its declaration exactly while its meta space is
 *  public (declaration.json). An unreachable PDS throws. */
export async function publiclyDeclared(
	groupDid: string,
	hosts: Pick<SpaceHosts, 'repoHost'> = didSpaceHosts
): Promise<boolean> {
	const pds = await hosts.repoHost(groupDid);
	const handle: XrpcHandle = (pathname, init) => fetch(new URL(pathname, pds), init);
	return repoRecordExists(handle, groupDid, GROUP_DECLARATION_COLLECTION, GROUP_DECLARATION_RKEY);
}
