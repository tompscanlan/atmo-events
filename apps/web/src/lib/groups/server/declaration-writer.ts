// Publishes and withdraws a group's `declaration`, its one anonymously readable
// record. It lives in the group's public repo, and only a public group has one:
// its presence is all an anonymous peer can see of a group.
//
// A withdrawal tells our own index at once, so browse drops a group that turned
// private. A declare never does: `notifyOfUpdate` deletes the entry on any answer
// that is not a record, a 5xx included, so it could drop a live declaration.
// Jetstream brings a new declaration in instead.
import {
	GROUP_DECLARATION_COLLECTION,
	GROUP_DECLARATION_RKEY,
	declarationRequired,
	groupDeclarationRecord
} from '../declaration-record';
import { type GroupRow, type GroupVisibility } from '../types';
import type { GroupSpaceReader } from './about-read';

import { contrailNotifier, type GroupEventNotifier } from './events-index';

import { groupWriter, requireGroupPermission, type GroupRepoWriter, ownSpace } from './group-write';

const aboutSpace = (group: GroupRow) =>
	ownSpace(group, 'about', group.about_space_uri, 'it cannot be declared to the network');
import { type CredentialStoreEnv } from './session';
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

export interface WithdrawGroupDeclarationInput extends WriteGroupDeclarationInput {
	notify?: GroupEventNotifier;
}

export interface DeclarationWriteResult {
	uri: string;
	cid: string;
}

/** Read off the row. A declaration must not point at a space that was never made,
 *  nor at one of another type: the lexicon requires the group's own meta space. */

/** Puts the declaration, keyed `self`, so re-declaring overwrites. */
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

	const writer = input.writer ?? (await groupWriter(input.env, input.group));
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

/** Deletes the declaration, then tells our index. Safe when there is none: the
 *  PDS treats deleting a missing record as a no-op. The index is told only after
 *  the delete lands, so it never drops a declaration the repo still holds. */
export async function removeGroupDeclaration(input: WithdrawGroupDeclarationInput): Promise<void> {
	await requireGroupPermission(input, 'MANAGE_GROUP');

	const writer = input.writer ?? (await groupWriter(input.env, input.group));
	await writer({
		repo: input.group.group_did,
		collection: GROUP_DECLARATION_COLLECTION,
		rkey: GROUP_DECLARATION_RKEY,
		record: {},
		intent: 'delete'
	});

	await forgetDeclaration(input);
}

/** A failure is logged, not thrown, as in `notifyIndex` (./event-writer.ts). */
async function forgetDeclaration(input: WithdrawGroupDeclarationInput): Promise<void> {
	const uri = `at://${input.group.group_did}/${GROUP_DECLARATION_COLLECTION}/${GROUP_DECLARATION_RKEY}`;
	try {
		await (input.notify ?? contrailNotifier(input.db))(uri);
	} catch (e) {
		console.error(`[groups] could not tell the index that ${uri} was withdrawn:`, e);
	}
}

/**
 * Declares a public group and withdraws a private group's declaration.
 * `visibility` is the caller's: the form's on a save, the host's on a repair.
 * `assumeAbsent` skips the delete on create, where a new repo holds none.
 */
export async function reconcileGroupDeclaration(
	input: WithdrawGroupDeclarationInput & { visibility: GroupVisibility; assumeAbsent?: boolean }
): Promise<DeclarationWriteResult | null> {
	// A declare must never tell the index, so `input.notify` stops here.
	if (declarationRequired(input.visibility)) return writeGroupDeclaration(input);
	if (input.assumeAbsent) return null;
	await removeGroupDeclaration(input);
	return null;
}
