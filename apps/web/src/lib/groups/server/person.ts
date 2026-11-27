// A group as the signed-in person may see it, read with their own access through main's space
// credential: their PDS signs a delegation for the group's space, and the group host, its
// authority, gives a credential for it only to someone the space's policy lets read it. So a
// public group's meta space is read by anyone whose PDS has spaces, and a private one, and the
// members space, by its members alone.
import type { CallerSession } from '#lib/private-events/server/caller.js';
import { isSpaceAccessDenied } from '#lib/spaces/server/space-credential.js';
import { credentialSpaceReader, type SpaceReader } from '#lib/spaces/server/space-read.js';
import { groupJoinPolicy } from '../fields';
import {
	GROUP_ABOUT_COLLECTION,
	GROUP_ABOUT_RKEY,
	GROUP_CONFIG_COLLECTION,
	GROUP_CONFIG_RKEY,
	GROUP_MEMBERSHIP_COLLECTION,
	membershipRkey,
	membersSpaceUri,
	metaSpaceUri,
	SPACE_POLICY_COLLECTION,
	SPACE_POLICY_RKEY,
	type GroupJoinPolicy
} from '../ids';
import { groupMetaOf, type GroupMeta } from './group';

export interface PersonalMeta extends GroupMeta {
	/** From the group's config. The host treats a group with none as one that approves its
	 *  members, so this does too. */
	joinPolicy: GroupJoinPolicy;
}

/** One for each request, since it holds the credentials it buys. */
export function personReader(caller: CallerSession): SpaceReader {
	return credentialSpaceReader(caller);
}

/** The about record, the config and the published policy. Throws `SpaceAccessDenied` when the host
 *  does not let the person read the meta space. */
export async function readMetaAsPerson(
	reader: SpaceReader,
	groupDid: string
): Promise<PersonalMeta> {
	const space = metaSpaceUri(groupDid);
	const read = (collection: string, rkey: string) =>
		reader.get({ space, repo: groupDid, collection, rkey });
	const [about, config, policy] = await Promise.all([
		read(GROUP_ABOUT_COLLECTION, GROUP_ABOUT_RKEY),
		read(GROUP_CONFIG_COLLECTION, GROUP_CONFIG_RKEY),
		read(SPACE_POLICY_COLLECTION, SPACE_POLICY_RKEY)
	]);
	return {
		...groupMetaOf(about?.value ?? null, policy?.value ?? null),
		joinPolicy: groupJoinPolicy(config?.value.joinPolicy) ?? 'approval'
	};
}

/** A member has a membership in the group's repo in its members space, keyed by their DID, which
 *  only members may read. A person the host does not let in is not a member; any other failure
 *  throws, SpaceNotFound among them: their PDS answers it for a refusal and also when it could not
 *  reach the host, so it says nothing either way. */
export async function isMemberAsPerson(
	reader: SpaceReader,
	groupDid: string,
	personDid: string
): Promise<boolean> {
	try {
		const found = await reader.get({
			space: membersSpaceUri(groupDid),
			repo: groupDid,
			collection: GROUP_MEMBERSHIP_COLLECTION,
			rkey: membershipRkey(personDid)
		});
		return found !== null;
	} catch (e) {
		if (isSpaceAccessDenied(e) && !e.reason.endsWith('SpaceNotFound')) return false;
		throw e;
	}
}

/** A membership's roles, each once, in the order written; null for a record without a list. */
function membershipRoles(value: unknown): string[] | null {
	const roles = (value as { roles?: unknown } | null)?.roles;
	if (!Array.isArray(roles)) return null;
	return [...new Set(roles.filter((role): role is string => typeof role === 'string' && !!role))];
}

/** The person's own roles, from their membership, read as `isMemberAsPerson` reads it; null when
 *  they could not be read or they hold none. */
export async function readRolesAsPerson(
	reader: SpaceReader,
	groupDid: string,
	personDid: string
): Promise<string[] | null> {
	const found = await reader.get({
		space: membersSpaceUri(groupDid),
		repo: groupDid,
		collection: GROUP_MEMBERSHIP_COLLECTION,
		rkey: membershipRkey(personDid)
	});
	return found ? membershipRoles(found.value) : null;
}
