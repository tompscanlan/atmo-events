// A group's three member lists: the host's record of who may read each of the
// group's spaces, and whose writes into it the host tracks.
//
// The lists are host state, not records. The space owner (the group account)
// edits them with `com.atproto.simplespace.putMember` and `removeMember`, and
// reads them with `listMembers`, which is owner-only and paged. There is no
// single-member read.
//
// Each list follows its space's `access` record, which is the policy: a member
// is listed `read:true write:true` on a space exactly when a role their
// membership names is granted `read` there, since reading a space and writing
// your own records in it are one grant. (Spec: FR-214; FR-206 is this rule for
// the members space.) atmo gives every role it creates `read` in every space,
// so today every member is on all three lists.
//
//   * The about space's entries do not depend on the group's visibility, so a
//     switch to private needs no backfill.
//   * The members space's entry goes first. It must exist before the member
//     writes their `acceptance` into their own repo, or the host accepts that
//     write and never tracks it.
//   * The calendar space's entry lets a member read members-only events with
//     their own credential. atmo itself reads them as the group.
//
// A join requester is not a member, so a request puts nothing on any list.
import { type GroupRow } from '../types';
import { groupSpaceUris } from '../ids';
import {
	accessGrantsRead,
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	parseGroupAccess,
	type GroupAccessFields
} from '../members-record';

import type { GroupSpaceReader } from './about-read';
import {
	groupClient,
	type CredentialStoreEnv,
	type GroupCredential,
	requireGroupCredential
} from './session';
import { describeFailure, xrpc } from './xrpc';
import { GroupSpaceError } from './spaces';

import { ownSpace } from './group-write';
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

/** What a listed member holds, on every space. */
export const SPACE_MEMBER_ACCESS = { read: true, write: true } as const;

/** The group's spaces, in the order a member's entries are put: the members
 *  space first, before the member writes their acceptance. */
export const GROUP_SPACE_KINDS = ['members', 'about', 'calendar'] as const;

export type GroupSpaceKind = (typeof GROUP_SPACE_KINDS)[number];

/** Each space's `access` record as read. Null when it is missing, or is not an
 *  access record, which grants no one. */
export type GroupSpaceAccess = Record<GroupSpaceKind, GroupAccessFields | null>;

/** The largest page `listMembers` allows. */
const LIST_MEMBERS_LIMIT = 1000;

/** The real transport, over the group's own session: all three methods need
 *  the space owner's credential. `putMember` and `removeMember` are an upsert
 *  and a delete with no output, so repeating either is harmless. */
export function pdsMemberList(cred: GroupCredential, groupDid: string): GroupMemberList {
	const post = async (
		method: string,
		body: { space: string; did: string } & Record<string, unknown>
	) => {
		const { handle } = await groupClient(cred, groupDid);
		const answer = await xrpc(handle, `com.atproto.simplespace.${method}`, { body });
		if (!answer.ok) {
			throw new GroupSpaceError(
				`${method} failed for ${body.did} on ${body.space}: ${describeFailure(answer)}`,
				spaceTypeOf(body.space)
			);
		}
	};

	return {
		async put({ space, did, read, write }) {
			await post('putMember', {
				space,
				did,
				read,
				write
			});
		},
		async remove({ space, did }) {
			await post('removeMember', { space, did });
		},
		async list({ space, cursor }) {
			const { handle } = await groupClient(cred, groupDid);
			const answer = await xrpc(handle, 'com.atproto.simplespace.listMembers', {
				query: { space, limit: String(LIST_MEMBERS_LIMIT), ...(cursor ? { cursor } : {}) }
			});
			if (!answer.ok) {
				throw new GroupSpaceError(
					`listMembers failed on ${space}: ${describeFailure(answer)}`,
					spaceTypeOf(space)
				);
			}
			const data = answer.data;
			if (!('members' in data)) {
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
	group: GroupRow
): Promise<GroupMemberList> {
	return pdsMemberList(await requireGroupCredential(env, group.group_did), group.group_did);
}

type GroupSpaces = Pick<GroupRow, 'group_did' | 'about_space_uri' | 'members_space_uri'>;

/** The space a URI names, for the error a list call throws about it. */
function spaceTypeOf(space: string): string {
	return space.split('/space/')[1]?.split('/')[0] ?? space;
}

/** The about space URI. */
export function aboutSpace(group: Pick<GroupRow, 'group_did' | 'about_space_uri'>): string {
	return ownSpace(group, 'about', group.about_space_uri, 'its member list cannot be written');
}

/** The members space URI. */
export function membersSpace(group: Pick<GroupRow, 'group_did' | 'members_space_uri'>): string {
	return ownSpace(group, 'members', group.members_space_uri, 'its member list cannot be written');
}

/** All three space URIs, each checked to be the group's own. No column holds the
 *  calendar space's: it follows from the DID. NULL in either column means
 *  provisioning did not finish. */
export function groupSpaces(group: GroupSpaces): Record<GroupSpaceKind, string> {
	return {
		members: membersSpace(group),
		about: aboutSpace(group),
		calendar: groupSpaceUris(group.group_did).calendarSpaceUri
	};
}

/** The three spaces' `access` records, read together. A failed read throws, so a
 *  list is never derived from a policy that could not be read. */
export async function readSpaceAccess(
	reader: GroupSpaceReader,
	group: GroupSpaces
): Promise<GroupSpaceAccess> {
	const spaces = groupSpaces(group);
	const [members, about, calendar] = await Promise.all(
		GROUP_SPACE_KINDS.map(async (kind) => {
			const found = await reader.get({
				space: spaces[kind],
				repo: group.group_did,
				collection: GROUP_ACCESS_COLLECTION,
				rkey: GROUP_ACCESS_RKEY
			});
			return found ? parseGroupAccess(found.value) : null;
		})
	);
	return { members, about, calendar };
}

/** The spaces where a member holding `roleIds` belongs on the list. */
export function spacesReadBy(
	access: GroupSpaceAccess,
	roleIds: readonly string[]
): Set<GroupSpaceKind> {
	return new Set(GROUP_SPACE_KINDS.filter((kind) => accessGrantsRead(access[kind], roleIds)));
}

/** Lists a member on every space whose `access` grants one of `roleIds` read,
 *  and unlists them everywhere else: an entry, or a role change. The members
 *  space goes first. All three spaces are checked before any write. Removing an
 *  entry that is not there is a no-op on the host. */
export async function placeMember(
	list: GroupMemberList,
	group: GroupSpaces,
	did: string,
	roleIds: readonly string[],
	access: GroupSpaceAccess
): Promise<void> {
	const spaces = groupSpaces(group);
	const reads = spacesReadBy(access, roleIds);
	for (const kind of GROUP_SPACE_KINDS) {
		if (reads.has(kind)) await list.put({ space: spaces[kind], did, ...SPACE_MEMBER_ACCESS });
		else await list.remove({ space: spaces[kind], did });
	}
}

/** Takes a member off all three lists: an exit. The members space goes last, so
 *  the host still accepts the notice of their acceptance's delete. */
export async function unlistMember(
	list: GroupMemberList,
	group: GroupSpaces,
	did: string
): Promise<void> {
	const spaces = groupSpaces(group);
	for (const kind of [...GROUP_SPACE_KINDS].reverse()) {
		await list.remove({ space: spaces[kind], did });
	}
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
	/** Put on the list, or given `SPACE_MEMBER_ACCESS`. */
	added: string[];
	/** Taken off the list. */
	removed: string[];
}

/**
 * Makes a space's list hold exactly `holders`, each with `SPACE_MEMBER_ACCESS`.
 * `holders` must be every DID whose membership names a role the space's
 * `access` grants read: a DID missing from it loses read access, and on the
 * members space has its acceptance go untracked. The group's own DID is left
 * alone, since it owns the space. Only differences are written.
 */
export async function alignSpaceMembers(
	list: GroupMemberList,
	group: GroupSpaces,
	kind: GroupSpaceKind,
	holders: ReadonlySet<string>
): Promise<SpaceMemberAlignment> {
	const space = groupSpaces(group)[kind];
	const listed = await readSpaceMembers(list, space);
	const current = new Map(listed.map((member) => [member.did, member]));
	const added: string[] = [];
	const removed: string[] = [];

	for (const did of [...holders].sort()) {
		if (did === group.group_did) continue;
		const entry = current.get(did);
		if (entry && entry.read && entry.write) continue;
		await list.put({ space, did, ...SPACE_MEMBER_ACCESS });
		added.push(did);
	}
	for (const { did } of listed) {
		if (did === group.group_did || holders.has(did)) continue;
		await list.remove({ space, did });
		removed.push(did);
	}
	return { added, removed };
}
