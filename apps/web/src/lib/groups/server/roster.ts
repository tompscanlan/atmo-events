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
/** Memberships on one page of the roster, each with a confirmation read at the member's own PDS,
 *  so a page view makes a bounded number of reads at any size of group. */
const MEMBERS_PER_PAGE = 100;
/** Handles looked up for one page, at most. */
const MAX_HANDLES = 200;

interface ListedRecord {
	rkey: string;
	value: Record<string, unknown>;
}

/** The group's members space, read with one credential bought with `holder`'s own access. */
export function membersSpace(holder: SpaceHolder, groupDid: string, hosts: SpaceHosts) {
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

	/** One page of `collection`'s records in the group's repo there, and the cursor for the next,
	 *  null on the last; or a throw. Not authenticated: `listRecords` carries no MAC, so nothing
	 *  here shows the values are the group's, as a record read with `getRecord` is shown. */
	const page = async (
		collection: string,
		cursor: string | null,
		limit = LIST_LIMIT
	): Promise<{ records: ListedRecord[]; cursor: string | null }> => {
		const answer = await ask(await hosts.repoHost(groupDid), groupDid, LIST_RECORDS, {
			space,
			repo: groupDid,
			collection,
			limit: String(limit),
			...(cursor ? { cursor } : {})
		});
		if (!answer.ok) throw answerError(LIST_RECORDS, answer);
		const listed = Array.isArray(answer.data.records) ? answer.data.records : [];
		const records: ListedRecord[] = [];
		for (const entry of listed) {
			const { collection: of, rkey, value } = (entry ?? {}) as Record<string, unknown>;
			// A host that ignored the filter must not turn other records into these.
			if (of !== collection || typeof rkey !== 'string') continue;
			const record = value && typeof value === 'object' ? value : {};
			records.push({ rkey, value: record as Record<string, unknown> });
		}
		// The group host answers `cursor: null` on the last page.
		const next = typeof answer.data.cursor === 'string' && answer.data.cursor;
		return { records, cursor: next && next !== cursor && listed.length > 0 ? next : null };
	};

	return {
		page,
		/** Every record of `collection` in the group's repo there, or a throw. */
		async list(collection: string): Promise<ListedRecord[]> {
			const records: ListedRecord[] = [];
			let cursor: string | null = null;
			for (let at = 0; at < MAX_LIST_PAGES; at++) {
				const listed = await page(collection, cursor);
				records.push(...listed.records);
				if (!listed.cursor) return records;
				cursor = listed.cursor;
			}
			throw new Error(`${LIST_RECORDS} went past ${MAX_LIST_PAGES} pages`);
		},
		/** A membership in the group's repo, read with its MAC; null when there is none. */
		async membership(memberDid: string): Promise<Record<string, unknown> | null> {
			const answer = await ask(await hosts.repoHost(groupDid), groupDid, GET_RECORD, {
				space,
				repo: groupDid,
				collection: GROUP_MEMBERSHIP_COLLECTION,
				rkey: membershipRkey(memberDid)
			});
			if (answerIsRecordNotFound(answer)) return null;
			if (!answer.ok) throw answerError(GET_RECORD, answer);
			const { value } = answer.data;
			return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
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
	/** One page of memberships, in the group host's order across pages, oldest first within it. */
	entries: RosterEntry[];
	/** The group host's cursor for the next page; null on the last. */
	next: string | null;
	/** The group's roles, `admin` and `member` and any others it made. */
	roles: RosterRole[];
	/** The caller's own roles; empty when they hold none. */
	yours: string[];
}

const byAge = (a: RosterEntry, b: RosterEntry) =>
	(a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.did.localeCompare(b.did);

/** One page of the roster, from the group host's cursor `after`, or its first page. Read with the
 *  caller's own access, which the group host gives only to its members: throws
 *  `SpaceAccessDenied` for anyone else. Every member's confirmation on the page is read, so whether
 *  each is listed never rests on a confirmation left unread; one that could not be read counts as
 *  not there, as for a member whose PDS has no spaces. `callerConfirmed` is the caller's own as
 *  already read for the group's page; when that is null it is read here like anyone's. */
export async function readRoster(
	caller: CallerSession,
	groupDid: string,
	callerConfirmed: boolean | null,
	after: string | null = null,
	hosts: SpaceHosts = didSpaceHosts
): Promise<Roster> {
	const reads = membersSpace(caller, groupDid, hosts);
	const [memberships, roleRecords] = await Promise.all([
		reads.page(GROUP_MEMBERSHIP_COLLECTION, after, MEMBERS_PER_PAGE),
		reads.list(GROUP_ROLE_COLLECTION)
	]);
	const members = memberships.records.flatMap(({ rkey, value }) => {
		const roles = membershipRoles(value);
		if (!roles) return [];
		const createdAt = typeof value.createdAt === 'string' ? value.createdAt : null;
		return [{ did: membershipDid(rkey), roles, createdAt }];
	});
	const dids = members.map((member) => member.did);
	const onPage = members.find((member) => member.did === caller.did);
	// Why confirmations were not read, by kind, never by whose: the DIDs would put a private
	// group's members in the logs at every view.
	const unread = new Map<string, number>();
	const [handles, confirmations, yours] = await Promise.all([
		handlesOf(dids),
		Promise.all(
			dids.map(async (did): Promise<boolean> => {
				if (did === caller.did && callerConfirmed !== null) return callerConfirmed;
				return reads.confirmed(did).catch((e) => {
					const kind = errorKind(e);
					unread.set(kind, (unread.get(kind) ?? 0) + 1);
					return false;
				});
			})
		),
		// Their own roles, from another page's membership when not on this one.
		onPage
			? onPage.roles
			: reads.membership(caller.did).then(
					(value) => (value && membershipRoles(value)) ?? [],
					() => []
				)
	]);
	if (unread.size > 0) {
		const count = [...unread.values()].reduce((sum, n) => sum + n, 0);
		const kinds = [...unread].map(([kind, n]) => `${kind} x${n}`).join(', ');
		console.info(`[groups] ${groupDid}: ${count} confirmations were not read: ${kinds}`);
	}
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
	return { entries, next: memberships.cursor, roles, yours };
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

export interface JoinRequests {
	/** Newest first. */
	requests: JoinRequestView[];
	/** The host had more after the last page read: older requests wait that are not here. */
	more: boolean;
}

/** The requests waiting to join, newest first, as the group: as many pages as `MAX_REQUEST_PAGES`
 *  at most, and whether the host had more. */
export async function listJoinRequests(writer: GroupWriter): Promise<JoinRequests> {
	const requests: Omit<JoinRequestView, 'handle'>[] = [];
	let cursor: string | undefined;
	let more = false;
	for (let page = 0; ; page++) {
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
		if (page + 1 >= MAX_REQUEST_PAGES) {
			more = true;
			break;
		}
		cursor = next;
	}
	const handles = await handlesOf(requests.map((request) => request.did));
	return {
		requests: requests.map((request) => ({ ...request, handle: handles.get(request.did) ?? null })),
		more
	};
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
 *  is read as the group, so the admin's own sign-in plays no part, and read here, just before the
 *  write, never taken from the page. The group host's `putRecord` in a space takes no
 *  `swapRecord`, so a narrow race remains: a change another admin makes between this read and the
 *  write is overwritten. */
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
		const refused = refusal(e);
		// Removed since the read: the host takes the put as a create, which admits only on request.
		if (refused instanceof RosterRefused && refused.reason === 'no-request') {
			throw new RosterRefused('not-member');
		}
		throw refused;
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
