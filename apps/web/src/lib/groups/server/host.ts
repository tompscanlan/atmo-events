// The group host, by the methods the groups standard gives it (proposal.md,
// "Methods", lex-refactor bce2966). A host is a PDS for group accounts: it hosts
// the group's spaces, keeps join requests privately, and checks roles. None runs
// yet, so atmo emulates one: the spaces are simplespaces on the group's own PDS,
// a join request is a D1 row, and each space's read policy and member list
// (./spaces.ts, ./member-list.ts), derived from its `access` record, stand in
// for the host's reading of that record. Routes reach the host only
// through `groupHost`, so a real host is a second adapter there, not a rewrite.
//
// Only the methods atmo calls are here, plus the roster acts the standard has
// no method for: approving a request, adding, ejecting and changing a role are
// membership writes over the group's session, and a write of the requester's
// membership is what approves their request. They sit on the binding anyway, so
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
import { type CredentialStoreEnv, type GroupCredential, requireGroupCredential } from './session';
import { pdsProvisioner, type GroupSpaceProvisioner, type SpaceProvision } from './spaces';

/** The group a host call is about. */
export interface HostBinding {
	db: D1Database;
	env: CredentialStoreEnv;
	group: GroupRow;
	/** The group's session when the caller holds one the store does not, as a
	 *  create holds the mint's. Else the store's, read on first use. */
	credential?: GroupCredential;
}

/** Who makes a call: the member behind service auth, or the admin behind the
 *  group-DID session. A handler's own context satisfies it. */
export type HostCaller = Omit<RosterContext, keyof HostBinding>;

export interface GroupHost {
	/** Group-DID session, `manage=create`. The space, with its read policy. */
	createSpace(space: SpaceProvision): Promise<{ uri: string }>;
	/** Group-DID session. The pending requests, which the host keeps privately. */
	listJoinRequests(): Promise<JoinRequestRow[]>;
	/** Group-DID session. Denies the member's pending request; the standard names
	 *  a request by its member, not by an id. */
	denyJoinRequest(caller: HostCaller, member: string): Promise<void>;
	/** Member service auth. A private request, or a join where the group takes one. */
	requestJoin(caller: HostCaller, message: string | null): Promise<JoinOutcome>;
	/** Member service auth. Withdraws the caller's own request, the only one they
	 *  can name. */
	cancelJoinRequest(caller: HostCaller): Promise<void>;
	/** Member service auth. Deletes the caller's membership record. */
	leaveGroup(caller: HostCaller): Promise<void>;
	/** Group-DID session. Writes the requester's membership, keyed by their DID,
	 *  which approves the request. No method of the standard's. */
	approveJoinRequest(
		caller: HostCaller,
		member: string,
		role: AssignableRole
	): Promise<{ did: string }>;
	/** Group-DID session. Writes a membership with no request behind it. */
	addMember(caller: HostCaller, did: string, role: AssignableRole): Promise<void>;
	/** Group-DID session. Deletes the member's membership record. */
	ejectMember(caller: HostCaller, did: string): Promise<void>;
	/** Group-DID session. Rewrites the member's membership with the role. */
	setMemberRole(caller: HostCaller, did: string, role: AssignableRole): Promise<void>;
}

/** The group's host: today the emulated one, and where a real host's adapter goes. */
export function groupHost(binding: HostBinding): GroupHost {
	const { db, env, group } = binding;
	const act = (caller: HostCaller): RosterContext => ({ ...caller, db, env, group });
	let provisioner: Promise<GroupSpaceProvisioner> | undefined;
	const provision = async () =>
		pdsProvisioner(
			binding.credential ?? (await requireGroupCredential(env, group.group_did)),
			group.group_did
		);

	return {
		createSpace: async (space) => (await (provisioner ??= provision()))(space),
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
