// Rebuilds a group's D1 cache from its records, keyed by the group DID. With
// every row but the credential deleted, a rebuild renders the same group.
// `rebuildGroup` takes whichever path the database leaves it:
//
//   a row survives   repair it: overwrite the profile columns and re-project
//                    the roster.
//   no row at all    restore it from records. The role rows go in before any
//                    membership, because `memberships.role_id` is a composite
//                    FK into `roles (id, group_id)`.
//
// Nothing is restored for visibility: it is the about space's read policy at
// the host, and no row holds it.
//
// A restore refuses, before any write, a group with no profile (`name` is NOT
// NULL), no authz records (no member could be restored), or no `membership`
// record granting `owner`, since `owner_did` can never be corrected once
// written.
import { GROUP_DECLARATION_COLLECTION, GROUP_DECLARATION_RKEY } from '../declaration-record';
import { GROUP_ROLES, type GroupPermission, type GroupRoleName } from '../permissions';
import type { GroupRow } from '../types';
import {
	pdsSpaceReader,
	readGroupAbout,
	rebuildGroupCache,
	type GroupSpaceReader
} from './about-read';
import {
	resolveGroupCredential,
	type CredentialStoreEnv,
	type GroupCredential
} from './credentials';
import {
	hasAuthzRecords,
	ownerDidFromRecords,
	projectGroupMembers,
	readGroupMembers,
	rebuildGroupMembers,
	type GroupMembers,
	type MembersRebuildResult
} from './members-read';
import { getGroupByDid, restoreGroup } from './repo';
import { groupClient } from './session';

import { groupSpaceUris } from '../ids';
/** A rebuild that stopped before writing anything. `reason` is a stable tag,
 *  so a command can report it without matching the message. */
export class GroupRebuildRefused extends Error {
	constructor(
		readonly reason: 'no-profile' | 'no-owner-record' | 'no-authz-records',
		message: string
	) {
		super(message);
		this.name = 'GroupRebuildRefused';
	}
}

/** Where a rebuild reads from. Injectable, so tests need no live PDS. */
export interface GroupRebuildSources {
	/** The about and members spaces, through the group's own session. */
	reader: GroupSpaceReader;
	/** Whether the group's public repo holds its declaration. Only the repair
	 *  reads this (./repair.ts). */
	declared: () => Promise<boolean>;
}

export type GroupRebuildResult =
	| {
			path: 'repaired';
			group: GroupRow;
			profile: 'repaired' | 'no-profile';
			members: MembersRebuildResult;
	  }
	| { path: 'restored'; group: GroupRow; members: MembersRebuildResult };

/** The rebuild command's sources for a group, or null when this deployment
 *  holds no credential for it. */
export async function groupRebuildSources(
	env: CredentialStoreEnv,
	db: D1Database,
	groupDid: string
): Promise<GroupRebuildSources | null> {
	const cred = await resolveGroupCredential(env, groupDid);
	if (!cred) return null;
	return {
		reader: pdsSpaceReader(cred, groupDid),
		declared: pdsDeclarationProbe(cred, groupDid)
	};
}

/** Rebuilds the group whose DID this is, from its records. */
export async function rebuildGroup(
	db: D1Database,
	sources: GroupRebuildSources,
	groupDid: string
): Promise<GroupRebuildResult> {
	const row = await getGroupByDid(db, groupDid);
	if (row) {
		const profile = await rebuildGroupCache(db, sources.reader, row);
		const members = await rebuildGroupMembers(db, sources.reader, row);
		const group = (await getGroupByDid(db, groupDid)) ?? row;
		return { path: 'repaired', group, profile: profile.outcome, members };
	}
	return restoreFromRecords(db, sources, groupDid);
}

async function restoreFromRecords(
	db: D1Database,
	sources: GroupRebuildSources,
	groupDid: string
): Promise<GroupRebuildResult> {
	const spaces = groupSpaceUris(groupDid);
	const located = {
		group_did: groupDid,
		about_space_uri: spaces.aboutSpaceUri,
		members_space_uri: spaces.membersSpaceUri
	};
	const [about, members] = await Promise.all([
		readGroupAbout(sources.reader, located),
		readGroupMembers(sources.reader, located)
	]);

	if (!about.profile) {
		throw new GroupRebuildRefused(
			'no-profile',
			`${groupDid} has no profile record, so there is no name to restore`
		);
	}
	const ownerDid = ownerDidFromRecords(members);
	if (!ownerDid) {
		throw new GroupRebuildRefused(
			'no-owner-record',
			`no membership record in ${groupDid} grants owner; refusing to guess one, since owner_did can never be corrected once written`
		);
	}
	if (!hasAuthzRecords(members)) {
		throw new GroupRebuildRefused(
			'no-authz-records',
			`${groupDid} has no role or permissions records, so no member could be restored`
		);
	}
	const owner = members.memberships.find((record) => record.subject === ownerDid);
	const now = Date.now();

	const group = await restoreGroup(db, {
		groupDid,
		ownerDid,
		name: about.profile.name,
		description: about.profile.description,
		requireApproval: about.profile.joinPolicy !== 'open',
		locationName: about.profile.locationName,
		aboutSpaceUri: spaces.aboutSpaceUri,
		membersSpaceUri: spaces.membersSpaceUri,
		createdAt: timestamp(about.profile.createdAt, now),
		roles: rolesFromRecords(members),
		ownerJoinedAt: timestamp(owner?.createdAt ?? null, now)
	});
	// The owner's row went in with the group. This restores everyone else.
	return { path: 'restored', group, members: await projectGroupMembers(db, members, group) };
}

/** The roles the records declare, each with the union of what both binding
 *  records grant it. Reading only one would drop every event grant. `owner` is
 *  always present: the schema creates its row, the records only bind it. */
function rolesFromRecords(
	members: GroupMembers
): { name: GroupRoleName; permissions: GroupPermission[] }[] {
	const declared = new Set<GroupRoleName>(members.roles.map((role) => role.id));
	declared.add('owner');
	return GROUP_ROLES.filter((name) => declared.has(name)).map((name) => {
		const permissions = new Set<GroupPermission>();
		for (const record of [members.permissions, members.eventPermissions]) {
			for (const binding of record?.bindings ?? []) {
				if (binding.role === name) for (const p of binding.permissions) permissions.add(p);
			}
		}
		return { name, permissions: [...permissions] };
	});
}

function timestamp(value: string | null, fallback: number): number {
	const parsed = value ? Date.parse(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : fallback;
}

/** Whether the group's public repo holds its declaration. An unreachable PDS
 *  throws, so the repair never acts on a state it could not read. */
function pdsDeclarationProbe(cred: GroupCredential, groupDid: string): () => Promise<boolean> {
	return async () => {
		const { handle } = await groupClient(cred, groupDid);
		const query = new URLSearchParams({
			repo: groupDid,
			collection: GROUP_DECLARATION_COLLECTION,
			rkey: GROUP_DECLARATION_RKEY
		});
		const res = await handle(`/xrpc/com.atproto.repo.getRecord?${query}`, { method: 'GET' });
		if (res.ok) return true;
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		if (res.status === 400 && body?.error === 'RecordNotFound') return false;
		throw new Error(`declaration probe for ${groupDid} failed: ${res.status} ${body?.error ?? ''}`);
	};
}
