// The about space's member list: the host's own record of who may read a
// group's face.
//
// Under `memberListPolicy`, a space is readable by a DID when the host's member
// list says so, with that DID's own credential and from any app. The list is
// host-internal state, not a record. The space owner (here the group account)
// edits it with `com.atproto.simplespace.putMember` and `removeMember`, and
// reads it back with `listMembers`, which is owner-only and paged. There is no
// single-member read.
//
// The roster is mirrored into the ABOUT space's list, for every group whatever
// its visibility. For a public group the list changes nothing today, because
// its read policy is public, and it is kept anyway so a later flip to private
// needs no backfill. Every entry is read: true, write: false: nothing a member
// authors is written into the about space, so no member's writes are tracked.
//
// Who writes it, and in what order:
//
//   ./roster.ts         a grant writes the membership record, then the entry;
//                       a revocation removes the entry, then the record
//   ../create-group.ts  the owner's entry, after the owner's record
//   ./repair.ts         the whole list, from the membership records
//
// The MEMBERS space's list is never written (./members-writer.ts says why).
// Every write here takes its space from `aboutSpace`, which refuses any other
// space.
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

/** The transport. Injectable, like `GroupSpaceProvisioner`, so the roster and
 *  Repair can be tested without a live PDS. */
export interface GroupMemberList {
	put(entry: { space: string } & SpaceMember): Promise<void>;
	remove(entry: { space: string; did: string }): Promise<void>;
	list(page: { space: string; cursor?: string }): Promise<SpaceMemberPage>;
}

/** What every roster member holds on the about space's list. */
export const ABOUT_MEMBER_ACCESS = { read: true, write: false } as const;

/** The largest page `listMembers` allows. */
const LIST_MEMBERS_LIMIT = 1000;

/** Named once because it is the one method called with a query string. */
const LIST_MEMBERS = '/xrpc/com.atproto.simplespace.listMembers';

/** The real transport: the group's own session, then the three simplespace
 *  methods. All three need the space owner's own credential, which the
 *  group's app password is. `putMember` and `removeMember` are an upsert and a
 *  delete on the host, so repeating either is harmless, and neither has an
 *  output, so success is the status alone. */
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

/** The transport for a group, from its stored credential. A deployment with no
 *  credential for the group cannot write its list, which is the same failure
 *  as any other write made as the group. */
export async function groupMemberList(
	env: CredentialStoreEnv,
	db: D1Database,
	group: GroupRow
): Promise<GroupMemberList> {
	const cred = await resolveGroupCredential(env, db, group.group_did);
	if (!cred) throw new GroupCredentialError(group.group_did);
	return pdsMemberList(cred, group.group_did);
}

/** `at://<group did>/space/<about type>/self`, the only space whose list this
 *  app writes. Read from the row, like `membersSpace` in ./members-writer.ts:
 *  NULL is a real state (provisioning did not finish), and failing with that
 *  message is better than writing to a space the PDS does not know. A URI of
 *  any other space type is refused as well, because a DID on the members
 *  space's list could read the whole roster from the host. */
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

/** Every entry on a space's list, following the cursor to the end. The host
 *  hands back a cursor with every page that has members in it, so the end is
 *  the first empty page, or a page with no cursor. A cursor that does not move
 *  would loop forever, and it throws instead. */
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
	/** Put on the list, or given the mirror's access where they held other. */
	added: string[];
	/** Taken off the list. */
	removed: string[];
}

/**
 * Makes the about space's list hold exactly `holders`, each with
 * `ABOUT_MEMBER_ACCESS`. The group's own DID is left alone either way: it owns
 * the space, and no list entry grants or takes away an owner's access.
 *
 * `holders` MUST be every DID that holds a membership record, read to the last
 * page. A DID missing from it is taken off the list, so a partial set would
 * strip read access from real members.
 *
 * Idempotent: the list is read first and only a difference is written, so a
 * second run makes no write.
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
