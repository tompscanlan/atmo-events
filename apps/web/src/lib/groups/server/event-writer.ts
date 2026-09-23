// THE WRITE GATE.
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
import {
	resolveGroupCredential,
	type CredentialStoreEnv,
	type GroupCredential
} from './credentials';
import { groupSpaceReader, type GroupSpaceReader } from './about-read';
import { getCallerMembership } from './repo';
import { groupClient } from './session';
import { contrailNotifier, type GroupEventNotifier } from './events-index';

export const GROUP_EVENT_COLLECTION = 'community.lexicon.calendar.event';

/** The caller's role does not grant the permission this write needs. */
export class GroupPermissionError extends Error {
	constructor(
		readonly permission: EnforcedGroupPermission,
		readonly groupDid: string
	) {
		super(`${permission} is required to do that in this group (${groupDid})`);
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
	/** Space-ref when this record belongs in one of the group's spaces
	 *  (`$lib/groups/server/spaces.ts`), absent when it belongs in the group's
	 *  PUBLIC repo.
	 *
	 *  Both shapes stay live on purpose. Public group EVENTS must remain plain
	 *  repo records — that is what Jetstream sees and what contrail indexes, and
	 *  a space is never anonymously readable. The CONTROL PLANE moves into
	 *  spaces. So the target is per-write, not per-writer. */
	space?: string;
}

/** The transport half of the gate: takes an already-authorised write and puts
 *  it in the group's repo. Injectable so the permission decision and the
 *  authorship decision can be asserted without a live PDS — and so the live
 *  integration test asserts the same object the unit test does. */
export type GroupRepoWriter = (write: GroupRepoWrite) => Promise<{ uri: string; cid: string }>;

/** The real transport: a password session for the group account, then the write.
 *  `expectDid` is checked against the session the PDS returns, so a mis-keyed
 *  credential map cannot silently author a group's events elsewhere.
 *
 *  Two method families, chosen by `write.space`: `com.atproto.repo.*` for the
 *  group's public repo, `com.atproto.space.*` for a record inside one of its
 *  spaces. The space methods take BOTH `space` and `repo` — `repo` is the DID
 *  whose slice inside the space is being written, which for every authority
 *  record is the group itself. */
export function pdsWriter(cred: GroupCredential, groupDid: string): GroupRepoWriter {
	return async (write) => {
		const { client, handle } = await groupClient(cred, groupDid);
		const collection = write.collection as `${string}.${string}.${string}`;
		// `repo` comes off a D1 row, so it is a plain string until it is checked.
		// @atcute's input types want an ActorIdentifier, and the check is the one
		// place that can honestly produce one — a group row whose did is malformed
		// must fail here rather than be smuggled past the type with a cast.
		const repo = write.repo;
		if (!isActorIdentifier(repo)) {
			throw new GroupRecordError(`${write.repo} is not a usable repo identifier`);
		}
		const space = write.space;

		// The space methods go through the raw handler because they are not in the
		// generated lexicon set; the repo methods stay on the typed client, which
		// validates their inputs. See `groupClient` for why this split is honest
		// rather than a workaround.
		const sendSpace = async (nsid: string, input: Record<string, unknown>) => {
			const res = await handle(`/xrpc/${nsid}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ space, repo, collection, ...input })
			});
			const data: unknown = await res.json().catch(() => null);
			if (!res.ok) throw new Error(`${nsid} failed: ${res.status} ${JSON.stringify(data)}`);
			return data;
		};

		if (write.intent === 'delete') {
			if (space) {
				await sendSpace('com.atproto.space.deleteRecord', { rkey: write.rkey });
			} else {
				const res = await client.post('com.atproto.repo.deleteRecord', {
					input: { repo, collection, rkey: write.rkey }
				});
				if (!res.ok) throw new Error(`deleteRecord failed: ${JSON.stringify(res.data)}`);
			}
			// deleteRecord returns no useful body in either family, so the URI is
			// rebuilt. A space record's URI is still authored by `repo`: the space
			// scopes access, it does not reparent the record.
			return { uri: `at://${write.repo}/${write.collection}/${write.rkey}`, cid: '' };
		}

		const create = write.intent === 'create';
		let body: unknown;
		if (space) {
			body = await sendSpace(
				create ? 'com.atproto.space.createRecord' : 'com.atproto.space.putRecord',
				{ rkey: write.rkey, record: write.record }
			);
		} else {
			const nsid = create ? 'com.atproto.repo.createRecord' : 'com.atproto.repo.putRecord';
			const res = await client.post(nsid, {
				input: { repo, collection, rkey: write.rkey, record: write.record }
			});
			if (!res.ok) throw new Error(`${nsid} failed: ${JSON.stringify(res.data)}`);
			body = res.data;
		}

		if (
			!(
				body &&
				typeof body === 'object' &&
				'uri' in body &&
				typeof body.uri === 'string' &&
				'cid' in body &&
				typeof body.cid === 'string'
			)
		) {
			throw new GroupRecordError(`the write returned no uri/cid`);
		}
		return { uri: body.uri, cid: body.cid };
	};
}

export interface WriteGroupEventInput {
	db: D1Database;
	env: CredentialStoreEnv;
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
	/** Overrides the members-space reader the gate resolves from. */
	reader?: GroupSpaceReader | null;
	/** Overrides the index notification. Tests pass this; nothing else should,
	 *  because a caller that supplies its own is a caller that can forget. */
	notify?: GroupEventNotifier;
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

/** What the gate needs, which every writer's input already carries. `reader`
 *  is the override tests pass; absent, the gate builds the group's own. */
export interface GroupGateInput {
	db: D1Database;
	env: CredentialStoreEnv;
	group: GroupRow;
	callerDid: string | null;
	reader?: GroupSpaceReader | null;
}

/** The gate's permission half, on its own so a second record class does not
 *  have to re-derive it. Events reach it through `authorise` below; the control
 *  plane reaches it directly (`./about-writer.ts`), because its permission is
 *  fixed rather than chosen by intent.
 *
 *  Refuses an anonymous caller before touching D1 or the PDS. What the caller
 *  may do is the RECORDS' answer (T016), with the fallback and fail-closed
 *  policy `getCallerMembership` documents. */
export async function requireGroupPermission(
	input: GroupGateInput,
	permission: EnforcedGroupPermission
): Promise<void> {
	const { db, group, callerDid } = input;
	if (!callerDid) throw new GroupPermissionError(permission, group.group_did);
	const reader =
		input.reader !== undefined ? input.reader : await groupSpaceReader(input.env, db, group);
	const membership = await getCallerMembership(db, group, callerDid, reader);
	if (!can(membership.permissions, permission)) {
		throw new GroupPermissionError(permission, group.group_did);
	}
}

async function authorise(
	input: GroupGateInput,
	intent: 'create' | 'update' | 'delete'
): Promise<EnforcedGroupPermission> {
	const permission = requiredPermission(intent);
	await requireGroupPermission(input, permission);
	return permission;
}

/** Tells the index about a record that is ALREADY in the group's repo.
 *
 *  Swallowing the failure is the point, and it belongs here rather than in any
 *  one notifier: by the time this runs the PDS has accepted the record, so a
 *  dead index means the events tab is briefly stale — and reporting that as a
 *  failed write would both be untrue and invite the caller to retry a write
 *  that landed. The next actor-scoped read backfills what was missed. */
async function notifyIndex(
	input: Pick<WriteGroupEventInput, 'db' | 'notify'>,
	uri: string
): Promise<void> {
	try {
		await (input.notify ?? contrailNotifier(input.db))(uri);
	} catch (e) {
		console.error(`[groups] could not tell the index about ${uri}:`, e);
	}
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

	const writer = input.writer ?? (await groupWriter(input.env, input.db, input.group));
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

	// The events tab reads the app's own index, not the group's PDS, so the
	// index has to be told. It happens here rather than at each route because
	// this is the one function that can produce a record under a group DID —
	// a second write path that forgot this call would ship a tab that silently
	// stops updating.
	await notifyIndex(input, result.uri);
	return { uri: result.uri, cid: result.cid, rkey, repo: input.group.group_did };
}

export async function deleteGroupEvent(
	input: Omit<WriteGroupEventInput, 'intent' | 'record'> & { rkey: string }
): Promise<{ uri: string; repo: string }> {
	await authorise(input, 'delete');
	const writer = input.writer ?? (await groupWriter(input.env, input.db, input.group));
	const result = await writer({
		repo: input.group.group_did,
		collection: GROUP_EVENT_COLLECTION,
		rkey: input.rkey,
		record: {},
		intent: 'delete'
	});
	assertAuthoredByGroup(result.uri, input.group.group_did);

	// Same call as a create or an edit, and the index works out which it was:
	// it re-fetches the URI, finds nothing there, and drops the row. A delete
	// that did not notify would leave the event on the tab until a backfill
	// that has already completed ran again, i.e. never.
	await notifyIndex(input, result.uri);
	return { uri: result.uri, repo: input.group.group_did };
}

/** The transport for a group's own repo, and for its spaces — one credential
 *  serves both, because a space write is authored by the same account.
 *
 *  `resolveGroupCredential` checks the operator secret first and the minted
 *  credential table second, so a group created through the form writes with the
 *  app password stored at mint while an operator override still wins. */
export async function groupWriter(
	env: CredentialStoreEnv,
	db: D1Database,
	group: GroupRow
): Promise<GroupRepoWriter> {
	const cred = await resolveGroupCredential(env, db, group.group_did);
	if (!cred) throw new GroupCredentialError(group.group_did);
	return pdsWriter(cred, group.group_did);
}

function assertAuthoredByGroup(uri: string, groupDid: string) {
	if (!uri.startsWith(`at://${groupDid}/`)) {
		throw new GroupRecordError(`group event landed at ${uri}, which is not ${groupDid}'s repo`);
	}
}
