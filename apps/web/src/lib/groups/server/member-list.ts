// The about space's member list: the host's record of who may read a group's
// face, with their own credential and from any app.
//
// The list is host state, not a record. The space owner (the group account)
// edits it with `com.atproto.simplespace.putMember` and `removeMember`, and
// reads it with `listMembers`, which is owner-only and paged. There is no
// single-member read.
//
// Every group mirrors its roster here, whatever its visibility, so a switch to
// private needs no backfill. Entries are read-only because members write
// nothing into the about space. The members space's list is never written.
import { ABOUT_SPACE_TYPE, type GroupRow } from '../types';
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
				ABOUT_SPACE_TYPE
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
					ABOUT_SPACE_TYPE
				);
			}
			if (!data || typeof data !== 'object' || !('members' in data)) {
				throw new GroupSpaceError(`listMembers returned no members for ${space}`, ABOUT_SPACE_TYPE);
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
	const cred = await resolveGroupCredential(env, db, group.group_did);
	if (!cred) throw new GroupCredentialError(group.group_did);
	return pdsMemberList(cred, group.group_did);
}

/** The about space URI, the only space whose list this app writes. NULL means
 *  provisioning did not finish. Any other space is refused, because a DID on
 *  the members space's list could read the whole roster from the host. */
export function aboutSpace(group: Pick<GroupRow, 'group_did' | 'about_space_uri'>): string {
	const space = group.about_space_uri;
	if (!space) {
		throw new GroupRecordError(
			`${group.group_did} has no about space yet, so its member list cannot be written`
		);
	}
	if (!space.startsWith(`at://${group.group_did}/space/${ABOUT_SPACE_TYPE}/`)) {
		throw new GroupRecordError(`${space} is not ${group.group_did}'s about space`);
	}
	return space;
}

/** Puts a roster member on the about space's list. */
export async function putAboutMember(
	list: GroupMemberList,
	group: Pick<GroupRow, 'group_did' | 'about_space_uri'>,
	did: string
): Promise<void> {
	await list.put({ space: aboutSpace(group), did, ...ABOUT_MEMBER_ACCESS });
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
			throw new GroupSpaceError(`listMembers repeated its cursor for ${space}`, ABOUT_SPACE_TYPE);
		}
		cursor = page.cursor;
	}
}

/** What aligning the list changed. */
export interface AboutMemberAlignment {
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
export async function alignAboutMembers(
	list: GroupMemberList,
	group: Pick<GroupRow, 'group_did' | 'about_space_uri'>,
	holders: ReadonlySet<string>
): Promise<AboutMemberAlignment> {
	const space = aboutSpace(group);
	const listed = await readSpaceMembers(list, space);
	const current = new Map(listed.map((member) => [member.did, member]));
	const added: string[] = [];
	const removed: string[] = [];

	for (const did of [...holders].sort()) {
		if (did === group.group_did) continue;
		const entry = current.get(did);
		if (
			entry &&
			entry.read === ABOUT_MEMBER_ACCESS.read &&
			entry.write === ABOUT_MEMBER_ACCESS.write
		) {
			continue;
		}
		await list.put({ space, did, ...ABOUT_MEMBER_ACCESS });
		added.push(did);
	}
	for (const { did } of listed) {
		if (did === group.group_did || holders.has(did)) continue;
		await list.remove({ space, did });
		removed.push(did);
	}
	return { added, removed };
}
