// The members page: who is in the group, read with the person's own access, and an admin's acts,
// done as the group through the session they linked, the reads they need included. Admitting
// someone is writing their membership in the members space, which the group host takes only for
// someone whose request waits; changing their roles rewrites it, and removing them deletes it. The
// host checks the approving person's roles at each one, and refuses what they may not do.
import type { CallerSession } from '#lib/private-events/server/caller.js';
import {
	didSpaceHosts,
	exchangeSpaceCredential,
	fetchWithCredential,
	GET_RECORD,
	spaceIdentity,
	type SpaceCredential,
	type SpaceHolder,
	type SpaceHosts
} from '#lib/spaces/server/space-credential.js';
import {
	ADMIN_ROLE,
	GROUP_CONFIRMATION_COLLECTION,
	GROUP_CONFIRMATION_RKEY,
	GROUP_MEMBERSHIP_COLLECTION,
	GROUP_ROLE_COLLECTION,
	MEMBER_ROLE,
	membersSpaceUri,
	membershipDid,
	membershipRkey
} from '../ids';
import {
	defaultRoles,
	membershipRecord,
	membershipRoles,
	roleOf,
	rolesWithAdmin,
	type JoinRequestView,
	type RosterEntry,
	type RosterRole
} from '../roster';
import { DENY_JOIN_REQUEST_NSID, LIST_JOIN_REQUESTS_NSID } from '../scopes';
import { credentialSpaceReader } from '#lib/spaces/server/space-read.js';
import type { GroupWriter } from './context';
import { groupHostSpaces } from './group';
import { answerError, answerIsRecordNotFound, errorKind, readXrpc, xrpc, XrpcError } from './xrpc';

const LIST_RECORDS = 'com.atproto.space.listRecords';
const LIST_LIMIT = 100;
const MAX_LIST_PAGES = 10;
/** Each confirmation is a read at the member's own PDS; past these, a member's is not read. */
const MAX_CONFIRMATION_READS = 100;
/** Handles looked up for one page, at most. */
const MAX_HANDLES = 200;

interface ListedRecord {
	rkey: string;
	value: Record<string, unknown>;
}

/** The group's members space, read with one credential bought with `holder`'s own access. */
function membersSpace(holder: SpaceHolder, groupDid: string, hosts: SpaceHosts) {
	const space = membersSpaceUri(groupDid);
	let credential: Promise<SpaceCredential> | undefined;
	const ask = async (
		host: string,
		audience: string,
		nsid: string,
		query: Record<string, string>
	) => {
		credential ??= hosts
			.repoHost(groupDid)
			.then((authorityHost) => exchangeSpaceCredential(holder, space, authorityHost));
		return readXrpc(
			await fetchWithCredential(await credential, hosts, { host, audience, nsid, query })
		);
	};

	return {
		/** Every record of `collection` in the group's repo there, or a throw. Not authenticated:
		 *  `listRecords` carries no MAC, so nothing here shows the values are the group's, as a
		 *  record read with `getRecord` is shown. */
		async list(collection: string): Promise<ListedRecord[]> {
			const host = await hosts.repoHost(groupDid);
			const records: ListedRecord[] = [];
			let cursor: string | undefined;
			for (let page = 0; page < MAX_LIST_PAGES; page++) {
				const answer = await ask(host, groupDid, LIST_RECORDS, {
					space,
					repo: groupDid,
					collection,
					limit: String(LIST_LIMIT),
					...(cursor ? { cursor } : {})
				});
				if (!answer.ok) throw answerError(LIST_RECORDS, answer);
				const listed = Array.isArray(answer.data.records) ? answer.data.records : [];
				for (const entry of listed) {
					const { collection: of, rkey, value } = (entry ?? {}) as Record<string, unknown>;
					// A host that ignored the filter must not turn other records into these.
					if (of !== collection || typeof rkey !== 'string') continue;
					const record = value && typeof value === 'object' ? value : {};
					records.push({ rkey, value: record as Record<string, unknown> });
				}
				// The group host answers `cursor: null` on the last page.
				const next = typeof answer.data.cursor === 'string' ? answer.data.cursor : undefined;
				if (!next || next === cursor || listed.length === 0) return records;
				cursor = next;
			}
			throw new Error(`${LIST_RECORDS} went past ${MAX_LIST_PAGES} pages`);
		},
		/** Whether the member's own confirmation is in their repo, read at their PDS with its MAC. */
		async confirmed(memberDid: string): Promise<boolean> {
			const answer = await ask(await hosts.repoHost(memberDid), memberDid, GET_RECORD, {
				space,
				repo: memberDid,
				collection: GROUP_CONFIRMATION_COLLECTION,
				rkey: GROUP_CONFIRMATION_RKEY
			});
			if (answerIsRecordNotFound(answer)) return false;
			if (!answer.ok) throw answerError(GET_RECORD, answer);
			return true;
		}
	};
}

/** Verified both ways, or null; at most `MAX_HANDLES` of them. */
export async function handlesOf(dids: readonly string[]): Promise<Map<string, string>> {
	const found = new Map<string, string>();
	await Promise.all(
		[...new Set(dids)].slice(0, MAX_HANDLES).map(async (did) => {
			try {
				const { handle } = await spaceIdentity(did);
				if (handle && handle !== 'handle.invalid') found.set(did, handle);
			} catch {
				// Shown by DID.
			}
		})
	);
	return found;
}

export interface Roster {
	/** Oldest membership first. */
	entries: RosterEntry[];
	/** The group's roles, `admin` and `member` and any others it made. */
	roles: RosterRole[];
	/** The caller's own roles; empty when they hold none. */
	yours: string[];
}

const byAge = (a: RosterEntry, b: RosterEntry) =>
	(a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.did.localeCompare(b.did);

/** Read with the caller's own access, which the group host gives only to its members: throws
 *  `SpaceAccessDenied` for anyone else. A member's confirmation that could not be read counts as
 *  not there, as for a member whose PDS has no spaces. `callerConfirmed` is the caller's own as
 *  already read for the group's page; when that is null it is read here like anyone's, past the
 *  limit too, since nothing writes it on a visit. */
export async function readRoster(
	caller: CallerSession,
	groupDid: string,
	callerConfirmed: boolean | null,
	hosts: SpaceHosts = didSpaceHosts
): Promise<Roster> {
	const reads = membersSpace(caller, groupDid, hosts);
	const [memberships, roleRecords] = await Promise.all([
		reads.list(GROUP_MEMBERSHIP_COLLECTION),
		reads.list(GROUP_ROLE_COLLECTION)
	]);
	const members = memberships.flatMap(({ rkey, value }) => {
		const roles = membershipRoles(value);
		if (!roles) return [];
		const createdAt = typeof value.createdAt === 'string' ? value.createdAt : null;
		return [{ did: membershipDid(rkey), roles, createdAt }];
	});
	const dids = members.map((member) => member.did);
	const [handles, confirmations] = await Promise.all([
		handlesOf(dids),
		Promise.all(
			dids.map(async (did, i): Promise<boolean | null> => {
				const own = did === caller.did;
				if (own && callerConfirmed !== null) return callerConfirmed;
				if (!own && i >= MAX_CONFIRMATION_READS) return null;
				return reads.confirmed(did).catch((e) => {
					console.info(`[groups] ${groupDid}: ${did}'s confirmation was not read: ${errorKind(e)}`);
					return false;
				});
			})
		)
	]);
	const entries = members
		.map((member, i) => ({
			...member,
			handle: handles.get(member.did) ?? null,
			confirmed: confirmations[i]
		}))
		.sort(byAge);
	const rank = (id: string) => (id === ADMIN_ROLE ? 0 : id === MEMBER_ROLE ? 1 : 2);
	const roles = roleRecords
		.map(({ rkey, value }) => roleOf(value, rkey))
		.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
	return {
		entries,
		roles,
		yours: members.find((member) => member.did === caller.did)?.roles ?? []
	};
}

/** Why the group host did not do what an admin asked, each worded for them on the members page. */
export type RosterRefusal =
	/** The host's own `LastConfigurer`: it would leave the group with no admin. */
	| 'last-admin'
	/** The host's own `NotAssignable`: the admin's roles may not give or take that role. */
	| 'not-assignable'
	/** The host's own `ScopeNotHeld`: the admin's roles do not hold what the role would give. */
	| 'scope-not-held'
	/** The host's own `MemberRole`: a membership must hold `member`. */
	| 'member-role'
	/** The spec's `JoinRequestNotFound`: nobody by that DID is waiting, so there is no one to admit. */
	| 'no-request'
	/** A create the host refused, with their membership there when read after: they are in already. */
	| 'already-member'
	/** Their membership is not there to change. */
	| 'not-member';

export class RosterRefused extends Error {
	constructor(readonly reason: RosterRefusal) {
		super(`the group host refused: ${reason}`);
		this.name = 'RosterRefused';
	}
}

// The group host's own names, not in the spec's lexicons, but `JoinRequestNotFound`.
const REFUSALS: Record<string, RosterRefusal> = {
	LastConfigurer: 'last-admin',
	NotAssignable: 'not-assignable',
	ScopeNotHeld: 'scope-not-held',
	MemberRole: 'member-role',
	JoinRequestNotFound: 'no-request'
};

/** A refusal named in `REFUSALS` as `RosterRefused`; anything else as it was thrown. */
function refusal(e: unknown): unknown {
	if (!(e instanceof XrpcError) || e.status !== 400 || !e.error) return e;
	const reason = REFUSALS[e.error];
	return reason ? new RosterRefused(reason) : e;
}

const MAX_REQUEST_PAGES = 5;

/** The requests waiting to join, newest first, as the group. */
export async function listJoinRequests(writer: GroupWriter): Promise<JoinRequestView[]> {
	const requests: Omit<JoinRequestView, 'handle'>[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < MAX_REQUEST_PAGES; page++) {
		const answer = await xrpc(writer.handle, LIST_JOIN_REQUESTS_NSID, {
			query: { limit: String(LIST_LIMIT), ...(cursor ? { cursor } : {}) }
		});
		const listed = Array.isArray(answer.requests) ? answer.requests : [];
		for (const entry of listed) {
			const { member, createdAt, message } = (entry ?? {}) as Record<string, unknown>;
			if (typeof member !== 'string' || !member.startsWith('did:')) continue;
			if (typeof createdAt !== 'string') continue;
			const said = typeof message === 'string' ? message.trim() : '';
			requests.push({ did: member, createdAt, message: said || null });
		}
		// `null` on the last page, from the group host, where the spec leaves it out.
		const next = typeof answer.cursor === 'string' && answer.cursor ? answer.cursor : undefined;
		if (!next || next === cursor || listed.length === 0) break;
		cursor = next;
	}
	const handles = await handlesOf(requests.map((request) => request.did));
	return requests.map((request) => ({ ...request, handle: handles.get(request.did) ?? null }));
}

/** Turns the request down. One no longer waiting (`JoinRequestNotFound`) is refused as approving
 *  it is: they withdrew, or another admin decided already, perhaps by approving them. */
export async function denyJoinRequest(writer: GroupWriter, memberDid: string): Promise<void> {
	try {
		await xrpc(writer.handle, DENY_JOIN_REQUEST_NSID, { body: { member: memberDid } });
	} catch (e) {
		throw refusal(e);
	}
}

const membershipAt = (writer: GroupWriter, memberDid: string) => ({
	repo: writer.did,
	space: membersSpaceUri(writer.did),
	collection: GROUP_MEMBERSHIP_COLLECTION,
	rkey: membershipRkey(memberDid)
});

/** `InvalidRequest` is the group host's generic error: a record already at the key is one cause
 *  among many, so what it means here is told by whether the membership is there once refused. */
const isInvalidRequest = (e: unknown) =>
	e instanceof XrpcError && e.status === 400 && e.error === 'InvalidRequest';

/** Whether the membership is there, as the group reads it; null when the read failed, which says
 *  nothing either way. */
const membershipThere = (writer: GroupWriter, memberDid: string, hosts: SpaceHosts) =>
	membershipAsGroup(writer, memberDid, hosts).then(
		(found) => found !== null,
		() => null
	);

/** A create, so it never replaces a member's roles: the host takes it only for someone whose
 *  request waits, and closes the request. With the roles the group marks `default`, which the spec
 *  gives everyone admitted on request, read as the group just before; making them an admin is a
 *  change after. */
export async function admitMember(
	writer: GroupWriter,
	memberDid: string,
	now: Date = new Date(),
	hosts: SpaceHosts = groupHostSpaces
): Promise<void> {
	const roles = defaultRoles(
		await membersSpace({ handle: writer.handle }, writer.did, hosts).list(GROUP_ROLE_COLLECTION)
	);
	try {
		await xrpc(writer.handle, 'com.atproto.space.createRecord', {
			body: {
				...membershipAt(writer, memberDid),
				record: membershipRecord(roles, now.toISOString())
			}
		});
	} catch (e) {
		if (isInvalidRequest(e) && (await membershipThere(writer, memberDid, hosts)) === true) {
			throw new RosterRefused('already-member');
		}
		throw refusal(e);
	}
}

/** A member's membership, read as the group through the admin's link, with its MAC checked; null
 *  when there is none. The link's membership scopes read for this: the host gives a group session
 *  a credential for the members space only when its scope reads that space, and only while the
 *  person who linked it may read it themselves. */
async function membershipAsGroup(
	writer: GroupWriter,
	memberDid: string,
	hosts: SpaceHosts
): Promise<Record<string, unknown> | null> {
	const { repo, space, collection, rkey } = membershipAt(writer, memberDid);
	const found = await credentialSpaceReader({ handle: writer.handle }, hosts).get({
		space,
		repo,
		collection,
		rkey
	});
	return found?.value ?? null;
}

/** Rewritten in place, keeping its date and every role this site does not change. The membership
 *  is read as the group, so the admin's own sign-in plays no part. */
export async function setMemberAdmin(
	writer: GroupWriter,
	memberDid: string,
	makeAdmin: boolean,
	hosts: SpaceHosts = groupHostSpaces
): Promise<void> {
	const where = membershipAt(writer, memberDid);
	const found = await membershipAsGroup(writer, memberDid, hosts);
	const roles = found ? membershipRoles(found) : null;
	if (!found || !roles) throw new RosterRefused('not-member');
	const createdAt =
		typeof found.createdAt === 'string' ? found.createdAt : new Date().toISOString();
	try {
		await xrpc(writer.handle, 'com.atproto.space.putRecord', {
			body: { ...where, record: membershipRecord(rolesWithAdmin(roles, makeAdmin), createdAt) }
		});
	} catch (e) {
		throw refusal(e);
	}
}

/** Deleting the membership puts them out; the host ends their access to the group's spaces. One
 *  already gone is what was asked: the group host answers that delete as done, making no change.
 *  A refusal with the membership gone when read after is taken as done too; with it still there,
 *  or unread, it is the failure it says. */
export async function removeMember(
	writer: GroupWriter,
	memberDid: string,
	hosts: SpaceHosts = groupHostSpaces
): Promise<void> {
	try {
		await xrpc(writer.handle, 'com.atproto.space.deleteRecord', {
			body: membershipAt(writer, memberDid)
		});
	} catch (e) {
		if (isInvalidRequest(e) && (await membershipThere(writer, memberDid, hosts)) === false) return;
		throw refusal(e);
	}
}
