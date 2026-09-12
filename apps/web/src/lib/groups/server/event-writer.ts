// THE WRITE GATE (bead om-3e5i).
//
// Every write helper in $lib/atproto/server/repo.remote.ts hard-sets
// `repo: locals.did`, and must keep doing so: those are the human's own repo
// writes, and the human's OAuth token can only write the human's repo anyway.
// A GROUP event is the opposite case. The record belongs to the group, so the
// group's admins co-edit ONE record set rather than each other's repos — which
// on atproto means the write must be authored by the group's own DID, because a
// repo write requires `repo === the authenticated DID`. Co-editing is custody.
//
// So this path never touches `locals.did` as the write target. `locals.did` is
// only the SUBJECT of a permission check; the CREDENTIAL is the group's, held
// by the app (see ./credentials.ts), and `repo` is always `group.group_did`.
//
// Public group events go to the group DID's PUBLIC repo, where they are
// anonymously readable and indexable by contrail. The members-only slice
// belongs in the group's space, which a public space cannot serve anonymously —
// that asymmetry is the reason for the split (decision 2 of the group model).
import { now as tidNow } from '@atcute/tid';
import * as v from '@atcute/lexicons/validations';
import { isActorIdentifier } from '@atcute/lexicons/syntax';
import { mainSchema as eventSchema } from '../../../lexicon-types/types/community/lexicon/calendar/event';
import { can, type EnforcedGroupPermission } from '../permissions';
import type { GroupRow } from '../types';
import { credentialFor, type GroupCredential } from './credentials';
import { getCallerMembership } from './repo';
import { groupClient } from './session';

export const GROUP_EVENT_COLLECTION = 'community.lexicon.calendar.event';

/** The caller's role does not grant the permission this write needs. */
export class GroupPermissionError extends Error {
	constructor(
		readonly permission: EnforcedGroupPermission,
		readonly groupSlug: string
	) {
		super(`${permission} is required to do that in ${groupSlug}`);
		this.name = 'GroupPermissionError';
	}
}

/** The app holds no credential for this group's DID, so it cannot author as the
 *  group. A configuration failure, never a user error. */
export class GroupCredentialError extends Error {
	constructor(readonly groupDid: string) {
		super(`no group credential is configured for ${groupDid}`);
		this.name = 'GroupCredentialError';
	}
}

export class GroupRecordError extends Error {
	constructor(
		message: string,
		readonly issues: readonly { path?: readonly unknown[]; code?: string }[] = []
	) {
		super(message);
		this.name = 'GroupRecordError';
	}
}

export interface GroupRepoWrite {
	/** Always the GROUP DID. The reason this whole module exists. */
	repo: string;
	collection: string;
	rkey: string;
	record: Record<string, unknown>;
	intent: 'create' | 'update' | 'delete';
}

/** The transport half of the gate: takes an already-authorised write and puts
 *  it in the group's repo. Injectable so the permission decision and the
 *  authorship decision can be asserted without a live PDS — and so the live
 *  integration test asserts the same object the unit test does. */
export type GroupRepoWriter = (write: GroupRepoWrite) => Promise<{ uri: string; cid: string }>;

/** The real transport: a password session for the group account, then a plain
 *  repo write. `expectDid` is checked against the session the PDS returns, so a
 *  mis-keyed credential map cannot silently author a group's events elsewhere. */
export function pdsWriter(cred: GroupCredential, groupDid: string): GroupRepoWriter {
	return async (write) => {
		const { client } = await groupClient(cred, groupDid);
		const collection = write.collection as `${string}.${string}.${string}`;
		// `repo` comes off a D1 row, so it is a plain string until it is checked.
		// @atcute's input types want an ActorIdentifier, and the check is the one
		// place that can honestly produce one — a group row whose did is malformed
		// must fail here rather than be smuggled past the type with a cast.
		const repo = write.repo;
		if (!isActorIdentifier(repo)) {
			throw new GroupRecordError(`${write.repo} is not a usable repo identifier`);
		}

		if (write.intent === 'delete') {
			const res = await client.post('com.atproto.repo.deleteRecord', {
				input: { repo, collection, rkey: write.rkey }
			});
			if (!res.ok) throw new Error(`deleteRecord failed: ${JSON.stringify(res.data)}`);
			return { uri: `at://${write.repo}/${write.collection}/${write.rkey}`, cid: '' };
		}

		const nsid =
			write.intent === 'create' ? 'com.atproto.repo.createRecord' : 'com.atproto.repo.putRecord';
		const res = await client.post(nsid, {
			input: {
				repo,
				collection,
				rkey: write.rkey,
				record: write.record
			}
		});
		if (!res.ok) throw new Error(`${nsid} failed: ${JSON.stringify(res.data)}`);
		const data = res.data as { uri: string; cid: string };
		return { uri: data.uri, cid: data.cid };
	};
}

export interface WriteGroupEventInput {
	db: D1Database;
	env: { GROUP_CREDENTIALS?: string };
	group: GroupRow;
	/** The human pressing the button. Checked, never written as. */
	callerDid: string | null;
	intent: 'create' | 'update';
	/** Record key. Required for `update`; minted as a TID for `create` when the
	 *  page has not minted one already (the /create route mints upfront). */
	rkey?: string;
	record: Record<string, unknown>;
	/** Overrides the PDS transport. Tests and the live probe pass this. */
	writer?: GroupRepoWriter;
}

export interface GroupEventWriteResult {
	uri: string;
	cid: string;
	rkey: string;
	/** Echoed back so a caller can assert what every test here asserts: the
	 *  author is the group, not the admin. */
	repo: string;
}

/** Permission by intent.
 *
 *  CREATE_EVENT to create; MANAGE_EVENTS to change or delete an existing group
 *  event. This is a deliberate narrowing of the legacy rule "the event's own
 *  creator, or a group manager": in this model the event's author IS the group,
 *  so there is no per-event creator to compare against, and v1 stores no
 *  provenance row that would invent one. It costs nothing in practice — under
 *  the legacy default bundles the only roles holding CREATE_EVENT (owner,
 *  admin) also hold MANAGE_EVENTS. */
function requiredPermission(intent: 'create' | 'update' | 'delete'): EnforcedGroupPermission {
	return intent === 'create' ? 'CREATE_EVENT' : 'MANAGE_EVENTS';
}

async function authorise(
	input: Pick<WriteGroupEventInput, 'db' | 'group' | 'callerDid'>,
	intent: 'create' | 'update' | 'delete'
): Promise<EnforcedGroupPermission> {
	const permission = requiredPermission(intent);
	if (!input.callerDid) throw new GroupPermissionError(permission, input.group.slug);
	const membership = await getCallerMembership(input.db, input.group.id, input.callerDid);
	// `permissions` is populated only from an ACTIVE membership, so a suspended
	// member resolves to the empty union and is refused here.
	if (!can(membership.permissions, permission)) {
		throw new GroupPermissionError(permission, input.group.slug);
	}
	return permission;
}

/** Authorises the caller, then writes a `community.lexicon.calendar.event`
 *  record into the GROUP DID's public repo. */
export async function writeGroupEvent(input: WriteGroupEventInput): Promise<GroupEventWriteResult> {
	await authorise(input, input.intent);

	if (input.intent === 'update' && !input.rkey) {
		throw new GroupRecordError('updating a group event needs its rkey');
	}
	const rkey = input.rkey ?? tidNow();
	const record = { ...input.record, $type: GROUP_EVENT_COLLECTION };

	// A malformed record would be accepted by the PDS (it does not know this
	// lexicon) and then poison every reader, so it is rejected here.
	const parsed = v.safeParse(eventSchema, record);
	if (!parsed.ok) {
		throw new GroupRecordError(
			'that is not a valid community.lexicon.calendar.event record',
			parsed.issues ?? []
		);
	}

	const writer = input.writer ?? resolveWriter(input.env, input.group);
	const result = await writer({
		repo: input.group.group_did,
		collection: GROUP_EVENT_COLLECTION,
		rkey,
		record,
		intent: input.intent
	});

	// Belt and braces: if the authority in the returned URI is not the group,
	// the record did not land where the model says it must, and a caller must
	// not be told the write succeeded.
	assertAuthoredByGroup(result.uri, input.group.group_did);
	return { uri: result.uri, cid: result.cid, rkey, repo: input.group.group_did };
}

export async function deleteGroupEvent(
	input: Omit<WriteGroupEventInput, 'intent' | 'record'> & { rkey: string }
): Promise<{ uri: string; repo: string }> {
	await authorise(input, 'delete');
	const writer = input.writer ?? resolveWriter(input.env, input.group);
	const result = await writer({
		repo: input.group.group_did,
		collection: GROUP_EVENT_COLLECTION,
		rkey: input.rkey,
		record: {},
		intent: 'delete'
	});
	assertAuthoredByGroup(result.uri, input.group.group_did);
	return { uri: result.uri, repo: input.group.group_did };
}

function resolveWriter(env: { GROUP_CREDENTIALS?: string }, group: GroupRow): GroupRepoWriter {
	const cred = credentialFor(env, group.group_did);
	if (!cred) throw new GroupCredentialError(group.group_did);
	return pdsWriter(cred, group.group_did);
}

function assertAuthoredByGroup(uri: string, groupDid: string) {
	if (!uri.startsWith(`at://${groupDid}/`)) {
		throw new GroupRecordError(`group event landed at ${uri}, which is not ${groupDid}'s repo`);
	}
}
