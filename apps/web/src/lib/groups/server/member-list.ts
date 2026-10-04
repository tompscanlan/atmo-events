// A group's two member lists: the host's record of who may read the group's
// face, and of whose writes into the members space it tracks.
//
// The lists are host state, not records. The space owner (the group account)
// edits them with `com.atproto.simplespace.putMember` and `removeMember`, and
// reads them with `listMembers`, which is owner-only and paged. There is no
// single-member read.
//
//   * The about space's list mirrors the roster, read-only, whatever the
//     group's visibility, so a switch to private needs no backfill. Members
//     write nothing into the about space.
//   * The members space's list holds every member and every pending join
//     requester, write-only, so the host tracks the `acceptance` each one
//     writes into their own repo (spec 003 FR-206). An entry must exist before
//     that write, or the host accepts it and never tracks it. `read` stays
//     false: a DID that could read the members space would see every
//     membership, role and permission record.
import { ABOUT_SPACE_TYPE, MEMBERS_SPACE_TYPE, type GroupRow } from '../types';
import {
	resolveGroupCredential,
	type CredentialStoreEnv,
	type GroupCredential
} from './credentials';
import { GroupCredentialError, GroupRecordError } from './event-writer';
import { groupClient } from './session';
import { GroupSpaceError } from './spaces';

/** One entry on a space's member list, as `listMembers` reports it. */
export interface SpaceMember {
	did: string;
	/** May read the space under a member-list read policy. */
	read: boolean;
	/** Has their writes tracked under a member-list write policy. */
	write: boolean;
}

/** One page of a member list, and where the next one starts. */
export interface SpaceMemberPage {
	members: SpaceMember[];
	cursor?: string;
}

/** The transport, injectable so tests need no live PDS. */
export interface GroupMemberList {
	put(entry: { space: string } & SpaceMember): Promise<void>;
	remove(entry: { space: string; did: string }): Promise<void>;
	list(page: { space: string; cursor?: string }): Promise<SpaceMemberPage>;
}

/** What every roster member holds on the about space's list. */
export const ABOUT_MEMBER_ACCESS = { read: true, write: false } as const;

/** What every member and pending requester holds on the members space's list.
 *  Never anything else, so no caller can hand out read access to the roster. */
export const MEMBERS_WRITER_ACCESS = { read: false, write: true } as const;

/** The largest page `listMembers` allows. */
const LIST_MEMBERS_LIMIT = 1000;

const LIST_MEMBERS = '/xrpc/com.atproto.simplespace.listMembers';

/** The real transport, over the group's own session: all three methods need
 *  the space owner's credential. `putMember` and `removeMember` are an upsert
 *  and a delete with no output, so repeating either is harmless. */
export function pdsMemberList(cred: GroupCredential, groupDid: string): GroupMemberList {
	const post = async (method: string, path: string, body: Record<string, unknown>) => {
		const { handle } = await groupClient(cred, groupDid);
		const res = await handle(path, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!res.ok) {
			const data: unknown = await res.json().catch(() => null);
			throw new GroupSpaceError(
				`${method} failed for ${String(body.did)} on ${String(body.space)}: ${res.status} ${JSON.stringify(data)}`,
				spaceTypeOf(String(body.space))
			);
		}
	};

	return {
		async put({ space, did, read, write }) {
			await post('putMember', '/xrpc/com.atproto.simplespace.putMember', {
				space,
				did,
				read,
				write
			});
		},
		async remove({ space, did }) {
			await post('removeMember', '/xrpc/com.atproto.simplespace.removeMember', { space, did });
		},
		async list({ space, cursor }) {
			const { handle } = await groupClient(cred, groupDid);
			const query = new URLSearchParams({ space, limit: String(LIST_MEMBERS_LIMIT) });
			if (cursor) query.set('cursor', cursor);
			const res = await handle(`${LIST_MEMBERS}?${query}`, { method: 'GET' });
			const data: unknown = await res.json().catch(() => null);
			if (!res.ok) {
				throw new GroupSpaceError(
					`listMembers failed on ${space}: ${res.status} ${JSON.stringify(data)}`,
					spaceTypeOf(space)
				);
			}
			if (!data || typeof data !== 'object' || !('members' in data)) {
				throw new GroupSpaceError(
					`listMembers returned no members for ${space}`,
					spaceTypeOf(space)
				);
			}
			const members = Array.isArray(data.members) ? data.members : [];
			return {
				members: members
					.filter(
						(m): m is SpaceMember =>
							!!m && typeof m === 'object' && typeof (m as SpaceMember).did === 'string'
					)
					.map((m) => ({ did: m.did, read: m.read === true, write: m.write === true })),
				cursor: 'cursor' in data && typeof data.cursor === 'string' ? data.cursor : undefined
			};
		}
	};
}

/** The transport for a group, from its stored credential. */
export async function groupMemberList(
	env: CredentialStoreEnv,
	db: D1Database,
	group: GroupRow
): Promise<GroupMemberList> {
	const cred = await resolveGroupCredential(env, group.group_did);
	if (!cred) throw new GroupCredentialError(group.group_did);
	return pdsMemberList(cred, group.group_did);
}

type GroupSpaces = Pick<GroupRow, 'group_did' | 'about_space_uri' | 'members_space_uri'>;

/** The type an error names, from the space URI it was about. */
function spaceTypeOf(space: string): string {
	return space.includes(`/space/${MEMBERS_SPACE_TYPE}/`) ? MEMBERS_SPACE_TYPE : ABOUT_SPACE_TYPE;
}

/** One of the group's own space URIs, checked to be its space of `type`. NULL
 *  means provisioning did not finish. */
function ownSpace(groupDid: string, uri: string | null, label: string, type: string): string {
	if (!uri) {
		throw new GroupRecordError(
			`${groupDid} has no ${label} space yet, so its member list cannot be written`
		);
	}
	if (!uri.startsWith(`at://${groupDid}/space/${type}/`)) {
		throw new GroupRecordError(`${uri} is not ${groupDid}'s ${label} space`);
	}
	return uri;
}

/** The about space URI, whose list gets read-only entries. */
export function aboutSpace(group: Pick<GroupRow, 'group_did' | 'about_space_uri'>): string {
	return ownSpace(group.group_did, group.about_space_uri, 'about', ABOUT_SPACE_TYPE);
}

/** The members space URI, whose list gets write-only entries. */
export function membersSpace(group: Pick<GroupRow, 'group_did' | 'members_space_uri'>): string {
	return ownSpace(group.group_did, group.members_space_uri, 'members', MEMBERS_SPACE_TYPE);
}

/** Both entries a roster member holds. The members space's write-only one goes
 *  first, so read access is the last thing granted. Both spaces are checked
 *  before either write. */
export async function listRosterMember(
	list: GroupMemberList,
	group: GroupSpaces,
	did: string
): Promise<void> {
	const about = aboutSpace(group);
	const members = membersSpace(group);
	await list.put({ space: members, did, ...MEMBERS_WRITER_ACCESS });
	await list.put({ space: about, did, ...ABOUT_MEMBER_ACCESS });
}

/** A pending join requester's one entry: write-only on the members space, so
 *  the acceptance they write at request time is tracked. */
export async function listJoinRequester(
	list: GroupMemberList,
	group: Pick<GroupRow, 'group_did' | 'members_space_uri'>,
	did: string
): Promise<void> {
	await list.put({ space: membersSpace(group), did, ...MEMBERS_WRITER_ACCESS });
}

/** Takes a requester's entry off the members space's list. */
export async function unlistJoinRequester(
	list: GroupMemberList,
	group: Pick<GroupRow, 'group_did' | 'members_space_uri'>,
	did: string
): Promise<void> {
	await list.remove({ space: membersSpace(group), did });
}

/** Every entry on a space's list. The host returns a cursor with every page
 *  that has members, so the end is an empty page or one with no cursor. A
 *  cursor that does not move throws instead of looping. */
export async function readSpaceMembers(
	list: GroupMemberList,
	space: string
): Promise<SpaceMember[]> {
	const members: SpaceMember[] = [];
	let cursor: string | undefined;
	for (;;) {
		const page = await list.list({ space, cursor });
		members.push(...page.members);
		if (!page.cursor || page.members.length === 0) return members;
		if (page.cursor === cursor) {
			throw new GroupSpaceError(`listMembers repeated its cursor for ${space}`, spaceTypeOf(space));
		}
		cursor = page.cursor;
	}
}

/** What aligning a list changed. */
export interface SpaceMemberAlignment {
	/** Put on the list, or given the mirror's access. */
	added: string[];
	/** Taken off the list. */
	removed: string[];
}

/**
 * Makes the about space's list hold exactly `holders`, each with
 * `ABOUT_MEMBER_ACCESS`. The group's own DID is left alone, since it owns the
 * space. `holders` must be every DID with a membership record: a DID missing
 * from it loses read access. Only differences are written.
 */
export function alignAboutMembers(
	list: GroupMemberList,
	group: Pick<GroupRow, 'group_did' | 'about_space_uri'>,
	holders: ReadonlySet<string>
): Promise<SpaceMemberAlignment> {
	return alignSpace(list, group.group_did, aboutSpace(group), ABOUT_MEMBER_ACCESS, holders);
}

/**
 * Makes the members space's list hold exactly `writers`, each with
 * `MEMBERS_WRITER_ACCESS`. `writers` must be every DID with a membership record
 * plus every pending requester: a DID missing from it has its acceptance go
 * untracked. An entry with any other access is rewritten, so a stray read
 * grant on the roster's space does not survive a repair.
 */
export function alignMemberWriters(
	list: GroupMemberList,
	group: Pick<GroupRow, 'group_did' | 'members_space_uri'>,
	writers: ReadonlySet<string>
): Promise<SpaceMemberAlignment> {
	return alignSpace(list, group.group_did, membersSpace(group), MEMBERS_WRITER_ACCESS, writers);
}

async function alignSpace(
	list: GroupMemberList,
	groupDid: string,
	space: string,
	access: { read: boolean; write: boolean },
	holders: ReadonlySet<string>
): Promise<SpaceMemberAlignment> {
	const listed = await readSpaceMembers(list, space);
	const current = new Map(listed.map((member) => [member.did, member]));
	const added: string[] = [];
	const removed: string[] = [];

	for (const did of [...holders].sort()) {
		if (did === groupDid) continue;
		const entry = current.get(did);
		if (entry && entry.read === access.read && entry.write === access.write) continue;
		await list.put({ space, did, ...access });
		added.push(did);
	}
	for (const { did } of listed) {
		if (did === groupDid || holders.has(did)) continue;
		await list.remove({ space, did });
		removed.push(did);
	}
	return { added, removed };
}
