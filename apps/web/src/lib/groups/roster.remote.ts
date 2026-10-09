// Joining and leaving a group, and an admin's changes to its roster, as remote
// forms. ./server/roster.ts is shared with the e2e harness, so both run the same
// sequence.
import { command, form, getRequestEvent } from '$app/server';
import * as v from 'valibot';
import { can } from './permissions';
import type { GroupFormResult } from './form-result';
import { notAllowed, rosterFailure } from './form-error';
import { assignableRoleField, didField, idField, memberActorField } from './form-fields';
import { callerMember, groupRequestContext, reauthorizeUrl } from './remote-context';
import { searchPeopleByHandle } from './server/people-search';
import { groupActorToDid } from './server/route-context';
import {
	admitFromRequest,
	admitMember,
	ejectMember,
	joinGroup,
	leaveGroup,
	rejectJoinRequest,
	promoteMember,
	withdrawJoinRequest
} from './server/roster';
import type { JoinOutcome } from './server/db/roster';

export const joinGroupForm = form(
	v.object({
		groupDid: didField,
		message: v.optional(v.pipe(v.string(), v.maxLength(1000)))
	}),
	async (data): Promise<GroupFormResult<{ outcome: JoinOutcome; reauthorize: string | null }>> => {
		const ctx = await groupRequestContext(data.groupDid);
		let outcome: JoinOutcome;
		try {
			outcome = await joinGroup({ ...ctx, member: await callerMember() }, data.message || null);
		} catch (e) {
			return rosterFailure(e);
		}
		const changed = outcome === 'joined' || outcome === 'pending';
		return { ok: true, outcome, reauthorize: changed ? await reauthorizeUrl(ctx) : null };
	}
);

/** Leave, or withdraw a pending request: one button, since for the applicant
 *  they are the same intent. The owner cannot leave (a GroupRuleError). */
export const leaveGroupForm = form(
	v.object({ groupDid: didField }),
	async (data): Promise<GroupFormResult<{ outcome: 'withdrawn' | 'left' }>> => {
		const ctx = { ...(await groupRequestContext(data.groupDid)), member: await callerMember() };
		try {
			// A pending applicant has no record: their write-only entry comes off
			// the members space's list, and the request closes.
			if (ctx.membership.pendingRequestId) {
				await withdrawJoinRequest(ctx, ctx.membership.pendingRequestId);
				return { ok: true, outcome: 'withdrawn' };
			}
			await leaveGroup(ctx);
			return { ok: true, outcome: 'left' };
		} catch (e) {
			return rosterFailure(e);
		}
	}
);

export const approveJoinRequestForm = form(
	v.object({
		groupDid: didField,
		requestId: idField,
		role: v.optional(assignableRoleField)
	}),
	async (data): Promise<GroupFormResult> => {
		const ctx = await groupRequestContext(data.groupDid);
		if (!can(ctx.membership.permissions, 'ADMIT_MEMBERS')) {
			return notAllowed(ctx.membership, 'ADMIT_MEMBERS');
		}
		try {
			await admitFromRequest(ctx, data.requestId, data.role ?? 'member');
			return { ok: true };
		} catch (e) {
			return rosterFailure(e);
		}
	}
);

export const rejectJoinRequestForm = form(
	v.object({ groupDid: didField, requestId: idField }),
	async (data): Promise<GroupFormResult> => {
		const ctx = await groupRequestContext(data.groupDid);
		if (!can(ctx.membership.permissions, 'ADMIT_MEMBERS')) {
			return notAllowed(ctx.membership, 'ADMIT_MEMBERS');
		}
		try {
			// A rejected request never granted anything, so there is no record,
			// only the requester's write-only entry and the request itself.
			await rejectJoinRequest(ctx, data.requestId);
			return { ok: true };
		} catch (e) {
			return rosterFailure(e);
		}
	}
);

/** Adds a member without a request, behind the same gate as approving one. It
 *  takes a handle or a DID. A handle is resolved here, after the permission
 *  check, and the DID it resolves to is what the roster records. */
export const addMemberForm = form(
	v.object({ groupDid: didField, actor: memberActorField, role: v.optional(assignableRoleField) }),
	async (data): Promise<GroupFormResult> => {
		const ctx = await groupRequestContext(data.groupDid);
		if (!can(ctx.membership.permissions, 'ADMIT_MEMBERS')) {
			return notAllowed(ctx.membership, 'ADMIT_MEMBERS');
		}
		let did: string;
		if ('did' in data.actor) {
			did = data.actor.did;
		} else {
			// Null for an unknown handle and for a resolver outage alike.
			const resolved = await groupActorToDid(data.actor.handle);
			if (!resolved) {
				return {
					ok: false,
					error: `Could not resolve ${data.actor.handle} to an account. Check the handle, or enter the DID.`
				};
			}
			did = resolved;
		}
		try {
			await admitMember(ctx, did, data.role ?? 'member');
			return { ok: true };
		} catch (e) {
			return rosterFailure(e);
		}
	}
);

/** Handle suggestions for the add-member form, from this deployment's own index
 *  (./server/people-search.ts). Signed-in callers only; the form itself still
 *  checks ADMIT_MEMBERS. */
export const suggestPeople = command(v.pipe(v.string(), v.maxLength(253)), async (prefix) => {
	const { locals, platform } = getRequestEvent();
	if (!locals.did) return [];
	return searchPeopleByHandle(platform!.env.DB, prefix);
});

export const removeMemberForm = form(
	v.object({ groupDid: didField, did: didField }),
	async (data): Promise<GroupFormResult> => {
		const ctx = await groupRequestContext(data.groupDid);
		if (!can(ctx.membership.permissions, 'EJECT_MEMBERS')) {
			return notAllowed(ctx.membership, 'EJECT_MEMBERS');
		}
		try {
			await ejectMember(ctx, data.did);
			return { ok: true };
		} catch (e) {
			return rosterFailure(e);
		}
	}
);

export const changeMemberRoleForm = form(
	v.object({ groupDid: didField, did: didField, role: assignableRoleField }),
	async (data): Promise<GroupFormResult> => {
		const ctx = await groupRequestContext(data.groupDid);
		if (!can(ctx.membership.permissions, 'ASSIGN_ROLES')) {
			return notAllowed(ctx.membership, 'ASSIGN_ROLES');
		}
		try {
			await promoteMember(ctx, data.did, data.role);
			return { ok: true };
		} catch (e) {
			return rosterFailure(e);
		}
	}
);
