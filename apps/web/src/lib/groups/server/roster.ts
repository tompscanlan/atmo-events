// A group's roster as the caller may see it, read with their own access: the host lets
// only those its members-space `access` names read the memberships at all.
import { createActorResolver } from '@svelte-atproto/oauth/network';
import type { ActorIdentifier } from '@atcute/lexicons';
import { atprotoNetwork } from '#lib/atproto/network.js';
import { membersSpaceUri } from '../ids';
import { primaryRole, type GroupPermission } from '../permissions';
import type { RosterEntry } from '../types';
import { accept } from './acceptance';
import type { CallerSession } from './caller';
import { readGroupMembers, resolveActor, rolesForDid, rosterFromRecords } from './members-read';
import { credentialAcceptanceReader } from './space-credential';
import { credentialSpaceReader } from './space-read';

export interface GroupRoster {
	entries: RosterEntry[];
	/** The caller's own role, null when they hold none. */
	role: string | null;
	permissions: GroupPermission[];
}

/** Throws `SpaceAccessDenied` for someone the host does not let read the roster. A member
 *  who has not confirmed gets their acceptance written now, as on any visit. */
export async function readRoster(caller: CallerSession, groupDid: string): Promise<GroupRoster> {
	const members = await readGroupMembers(credentialSpaceReader(caller), groupDid);
	const dids = members.memberships.map((record) => record.subject);
	const acceptances = await credentialAcceptanceReader(caller)
		.accepted(membersSpaceUri(groupDid), dids)
		.catch((e) => {
			console.warn(`[groups] ${groupDid}: acceptances could not be read:`, e);
			return null;
		});
	if (acceptances?.get(caller.did) === false && (await accept(caller, groupDid))) {
		acceptances.set(caller.did, true);
	}
	const { permissions } = resolveActor(members, caller.did, groupDid);
	return {
		entries: rosterFromRecords(members, acceptances),
		role: primaryRole(rolesForDid(members, caller.did)) ?? null,
		permissions: [...permissions]
	};
}

let resolver: ReturnType<typeof createActorResolver> | undefined;

/** Verified handles only; a DID whose handle fails the two-way check shows as its DID. */
export async function handlesOf(dids: readonly string[]): Promise<Record<string, string>> {
	resolver ??= createActorResolver({ network: atprotoNetwork() });
	const found: Record<string, string> = {};
	await Promise.all(
		dids.slice(0, 200).map(async (did) => {
			try {
				const { handle } = await resolver!.resolve(did as ActorIdentifier);
				if (handle !== 'handle.invalid') found[did] = handle;
			} catch {
				// Shown by DID.
			}
		})
	);
	return found;
}
