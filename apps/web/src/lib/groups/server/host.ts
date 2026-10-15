// The group host, by the methods the groups standard gives it (proposal.md,
// "Methods", lex-refactor bce2966). A host is a PDS for group accounts: it hosts
// the group's spaces, keeps join requests privately, and checks roles. Routes
// reach the host only through `groupHost`, which picks one of two adapters per
// group: a real host's methods, for a group at the host this deployment is set
// up with (./real-host.ts), or the stand-in host, for every other group. The
// stand-in emulates one: the spaces are simplespaces on the group's own PDS, a
// join request is a D1 row, and each space's read policy and member list
// (./spaces.ts, ./member-list.ts), derived from its `access` record, stand in
// for the host's reading of that record.
//
// Only the methods atmo calls are here, plus the roster acts the standard has
// no method for: approving a request, adding, ejecting and changing a role are
// membership writes over the acting admin's own group session, and a write of
// the requester's membership is what approves their request. What a host does
// for itself (a member's own join or leave, the member lists) the stand-in does
// on the session it acts on, its creator's (./session.ts). They sit on the binding anyway, so
// every roster act reaches the host one way and a real host's adapter takes all
// of them. (Spec: FR-515.)
import type { AssignableRole } from '../permissions';
import type { GroupRow, JoinRequestRow } from '../types';

import { listJoinRequests, type JoinOutcome } from './db/roster';
import {
	admitFromRequest,
	admitMember,
	ejectMember,
	joinGroup,
	leaveGroup,
	promoteMember,
	rejectJoinRequest,
	withdrawJoinRequest,
	type RosterContext
} from './roster';
import {
	type CredentialStoreEnv,
	type GroupCredential,
	GroupCredentialError,
	requireGroupCredential
} from './session';
import { pdsProvisioner, type GroupSpaceProvisioner, type SpaceProvision } from './spaces';
import { isHostGroup, realGroupHost } from './real-host';

/** The group a host call is about. */
export interface HostBinding {
	db: D1Database;
	env: CredentialStoreEnv;
	group: GroupRow;
	/** The group's session when the caller holds one the store does not, as a
	 *  create holds the mint's. Else the acting person's from the store, read on
	 *  first use. */
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

/** The group's host: the real one when the group is at the host this deployment
 *  is set up with, else the stand-in. Which one is decided on the first call. */
export function groupHost(binding: HostBinding): GroupHost {
	let chosen: Promise<GroupHost> | undefined;
	const host = () =>
		(chosen ??= isHostGroup(binding.env, binding.group.group_did).then((real) =>
			real ? realGroupHost(binding) : standInHost(binding)
		));
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
 *  session to ask the host with, which only they can fix, by linking one. */
export async function pendingRequestsFor(
	binding: HostBinding,
	caller: HostCaller
): Promise<JoinRequestRow[] | null> {
	try {
		return await groupHost(binding).listJoinRequests(caller);
	} catch (e) {
		if (e instanceof GroupCredentialError) return null;
		throw e;
	}
}

/** The stand-in host, for a group at no real host. */
function standInHost(binding: HostBinding): GroupHost {
	const { db, env, group } = binding;
	const act = (caller: HostCaller): RosterContext => ({ ...caller, db, env, group });
	// One provisioner per caller, since each writes on their own session.
	const provisioners = new Map<string, Promise<GroupSpaceProvisioner>>();
	const provision = async (caller: HostCaller) =>
		pdsProvisioner(
			binding.credential ?? (await requireGroupCredential(env, group.group_did, caller.callerDid)),
			group.group_did
		);
	const provisionerFor = (caller: HostCaller) => {
		let provisioner = provisioners.get(caller.callerDid);
		if (!provisioner) provisioners.set(caller.callerDid, (provisioner = provision(caller)));
		return provisioner;
	};

	return {
		createSpace: async (caller, space) => (await provisionerFor(caller))(space),
		listJoinRequests: () => listJoinRequests(db, group.id, 'pending'),
		denyJoinRequest: (caller, member) => rejectJoinRequest(act(caller), member),
		requestJoin: (caller, message) => joinGroup(act(caller), message),
		cancelJoinRequest: (caller) => withdrawJoinRequest(act(caller)),
		leaveGroup: (caller) => leaveGroup(act(caller)),
		approveJoinRequest: (caller, member, role) => admitFromRequest(act(caller), member, role),
		addMember: (caller, did, role) => admitMember(act(caller), did, role),
		ejectMember: (caller, did) => ejectMember(act(caller), did),
		setMemberRole: (caller, did, role) => promoteMember(act(caller), did, role)
	};
}
