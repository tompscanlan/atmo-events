// A declare never tells the index: it deletes the entry on any non-record answer.
import type { ResourceUri } from '@atcute/lexicons/syntax';
import { getServerClient } from '$lib/contrail/index';
import {
	GROUP_DECLARATION_COLLECTION,
	GROUP_DECLARATION_RKEY,
	groupDeclarationRecord
} from '../declaration-record';
import { VISIBILITY_WRITE } from '../grants';
import type { GroupRow, GroupVisibility } from '../types';
import type { GroupSpaceReader } from './about-read';
import { notifyIndex } from './events-index';
import { errorText } from './errors';
import { gatedWriter, requireGroupWrite, type GroupRepoWriter, ownSpace } from './group-write';
import type { CredentialStoreEnv } from './session';
import { didSpaceHosts, type SpaceHosts } from './space-credential';
import { repoRecordExists, type XrpcHandle } from './xrpc';

export interface WriteGroupDeclarationInput {
	db: D1Database;
	env: CredentialStoreEnv;
	group: GroupRow;
	callerDid: string | null;
	writer?: GroupRepoWriter;
	reader?: GroupSpaceReader | null;
}

const declarationUri = (groupDid: string): ResourceUri =>
	`at://${groupDid}/${GROUP_DECLARATION_COLLECTION}/${GROUP_DECLARATION_RKEY}`;

/** No permission set names the declaration, so it takes the scope of the meta `access`. */
export async function writeGroupDeclaration(
	input: WriteGroupDeclarationInput
): Promise<{ uri: string; cid: string }> {
	await requireGroupWrite(input, VISIBILITY_WRITE);
	const meta = ownSpace(input.group, 'about', input.group.about_space_uri, 'it cannot be listed');
	const writer = await gatedWriter(input);
	const result = await writer({
		repo: input.group.group_did,
		collection: GROUP_DECLARATION_COLLECTION,
		rkey: GROUP_DECLARATION_RKEY,
		record: {
			...groupDeclarationRecord({ aboutSpaceUri: meta }),
			$type: GROUP_DECLARATION_COLLECTION
		},
		intent: 'update'
	});
	return { uri: result.uri, cid: result.cid };
}

/** The repo no longer holds the declaration, but browse may still list the group. */
export class DeclarationIndexError extends Error {
	constructor(
		readonly groupDid: string,
		readonly cause: unknown
	) {
		super(`this site's index could not drop the declaration: ${errorText(cause)}`);
		this.name = 'DeclarationIndexError';
	}
}

export async function dropDeclarationFromIndex(db: D1Database, groupDid: string): Promise<void> {
	try {
		await notifyIndex(db, declarationUri(groupDid));
	} catch (e) {
		throw new DeclarationIndexError(groupDid, e);
	}
}

export async function removeGroupDeclaration(input: WriteGroupDeclarationInput): Promise<void> {
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

/** `declared`, when known, is whether the repo holds it already. */
export async function reconcileGroupDeclaration(
	input: WriteGroupDeclarationInput & {
		visibility: GroupVisibility;
		listed: boolean;
		declared?: boolean;
	}
): Promise<void> {
	if (input.visibility === 'public' && input.listed) {
		if (!input.declared) await writeGroupDeclaration(input);
		return;
	}
	if (input.declared !== false) await removeGroupDeclaration(input);
}

/** The index first, the repo itself only when the index has none. */
export async function publiclyDeclared(
	db: D1Database,
	groupDid: string,
	hosts: Pick<SpaceHosts, 'repoHost'> = didSpaceHosts
): Promise<boolean> {
	const indexed = await getServerClient(db)
		.get('rsvp.atmo.declaration.getRecord', { params: { uri: declarationUri(groupDid) } })
		.then((res) => res.ok)
		.catch(() => false);
	if (indexed) return true;
	const pds = await hosts.repoHost(groupDid);
	const handle: XrpcHandle = (pathname, init) => fetch(new URL(pathname, pds), init);
	return repoRecordExists(handle, groupDid, GROUP_DECLARATION_COLLECTION, GROUP_DECLARATION_RKEY);
}

export async function declarationExists(handle: XrpcHandle, groupDid: string): Promise<boolean> {
	return repoRecordExists(handle, groupDid, GROUP_DECLARATION_COLLECTION, GROUP_DECLARATION_RKEY);
}
