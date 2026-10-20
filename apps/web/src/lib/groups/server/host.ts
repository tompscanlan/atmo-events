// The group host, by the methods the groups standard gives it (proposal.md,
// "Methods", lex-refactor bce2966). A host is a PDS for group accounts: it hosts
// the group's spaces, keeps join requests privately, and checks roles. Routes
// reach the host only through `groupHost`, which takes a group at the host this
// deployment is set up with to that host's methods (./real-host.ts), and refuses
// any other group before sending anything: this site changes a group only
// through its host.
//
// Only the methods atmo calls are here, plus the roster acts the standard has
// no method for: approving a request, adding, ejecting and changing a role are
// membership writes over the acting admin's own group session, and a write of
// the requester's membership is what approves their request. They sit on the
// binding anyway, so every roster act reaches the host one way. (Spec: FR-515.)
import type { AssignableRole } from '../permissions';
import type { GroupRow, JoinRequestRow } from '../types';

import type { JoinOutcome } from './db/roster';
import type { RosterContext } from './roster';
import { type CredentialStoreEnv, type GroupCredential, GroupCredentialError } from './session';
import type { SpaceProvision } from './spaces';
import { isHostGroup } from './host-kind';
import { realGroupHost } from './real-host';

/** The group a host call is about. */
export interface HostBinding {
	db: D1Database;
	env: CredentialStoreEnv;
	group: GroupRow;
	/** The group's session when the caller holds one the store does not, as the
	 *  create does, after the host's sign-up. Else the acting person's from the
	 *  store, read on first use. */
	credential?: GroupCredential;
}

/** Who makes a call: the member behind service auth, or the admin behind their
 *  own group-DID session. A handler's own context satisfies it. */
export type HostCaller = Omit<RosterContext, keyof HostBinding>;

export interface GroupHost {
	/** The caller's group-DID session, `manage=create`. The space, with its read
	 *  policy. */
	createSpace(caller: HostCaller, space: SpaceProvision): Promise<{ uri: string }>;
	/** The caller's group-DID session. The pending requests, which the host keeps
	 *  privately. */
	listJoinRequests(caller: HostCaller): Promise<JoinRequestRow[]>;
	/** The caller's group-DID session. Denies the member's pending request; the standard names
	 *  a request by its member, not by an id. */
	denyJoinRequest(caller: HostCaller, member: string): Promise<void>;
	/** Member service auth. A private request, or a join where the group takes one. */
	requestJoin(caller: HostCaller, message: string | null): Promise<JoinOutcome>;
	/** Member service auth. Withdraws the caller's own request, the only one they
	 *  can name. */
	cancelJoinRequest(caller: HostCaller): Promise<void>;
	/** Member service auth. Deletes the caller's membership record. */
	leaveGroup(caller: HostCaller): Promise<void>;
	/** The caller's group-DID session. Writes the requester's membership, keyed by their DID,
	 *  which approves the request. No method of the standard's. */
	approveJoinRequest(
		caller: HostCaller,
		member: string,
		role: AssignableRole
	): Promise<{ did: string }>;
	/** The caller's group-DID session. Writes a membership with no request behind it. */
	addMember(caller: HostCaller, did: string, role: AssignableRole): Promise<void>;
	/** The caller's group-DID session. Deletes the member's membership record. */
	ejectMember(caller: HostCaller, did: string): Promise<void>;
	/** The caller's group-DID session. Rewrites the member's membership with the role. */
	setMemberRole(caller: HostCaller, did: string, role: AssignableRole): Promise<void>;
}

/** The group is not at the group host this deployment is set up with, so this
 *  site cannot change it: it changes a group only through its host. Thrown
 *  before any request. */
export class GroupNotAtHostError extends Error {
	constructor(readonly groupDid: string) {
		super(`${groupDid} is not at this site's group host, so this site cannot change it`);
		this.name = 'GroupNotAtHostError';
	}
}

/** The group's host, when the group is at the host this deployment is set up
 *  with. Which host serves it is resolved on the first call; a group at any
 *  other is refused then, with GroupNotAtHostError. */
export function groupHost(binding: HostBinding): GroupHost {
	let chosen: Promise<GroupHost> | undefined;
	const host = () =>
		(chosen ??= isHostGroup(binding.env, binding.group.group_did).then((atHost) => {
			if (!atHost) throw new GroupNotAtHostError(binding.group.group_did);
			return realGroupHost(binding);
		}));
	return {
		createSpace: async (caller, space) => (await host()).createSpace(caller, space),
		listJoinRequests: async (caller) => (await host()).listJoinRequests(caller),
		denyJoinRequest: async (caller, member) => (await host()).denyJoinRequest(caller, member),
		requestJoin: async (caller, message) => (await host()).requestJoin(caller, message),
		cancelJoinRequest: async (caller) => (await host()).cancelJoinRequest(caller),
		leaveGroup: async (caller) => (await host()).leaveGroup(caller),
		approveJoinRequest: async (caller, member, role) =>
			(await host()).approveJoinRequest(caller, member, role),
		addMember: async (caller, did, role) => (await host()).addMember(caller, did, role),
		ejectMember: async (caller, did) => (await host()).ejectMember(caller, did),
		setMemberRole: async (caller, did, role) => (await host()).setMemberRole(caller, did, role)
	};
}

/** The pending requests a page lists, or null when the viewer holds no group
 *  session to ask the host with, which only they can fix, by linking one. A
 *  group at no host this site can ask has none to list. */
export async function pendingRequestsFor(
	binding: HostBinding,
	caller: HostCaller
): Promise<JoinRequestRow[] | null> {
	try {
		return await groupHost(binding).listJoinRequests(caller);
	} catch (e) {
		if (e instanceof GroupCredentialError) return null;
		if (e instanceof GroupNotAtHostError) return [];
		throw e;
	}
}
