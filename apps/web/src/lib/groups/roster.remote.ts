// Joining and leaving a group, and an admin's changes to its roster, as remote
// forms. Every act goes through the group's host (./server/host.ts).
import type { Did } from '@atcute/lexicons';
import { command, form, getRequestEvent } from '$app/server';
import * as v from 'valibot';
import { can } from './permissions';
import type { GroupFormResult } from './form-result';
import { formError, notAllowed } from './form-error';
import { assignableRoleField, didField, memberActorField } from './form-fields';
import { groupRequestContext } from './remote-context';
import { callerSession } from './server/caller';
import { groupActorToDid } from './server/route-context';
import { groupHost } from './server/host';
import { authorizeSignIn } from './server/sign-in-grants';
import type { JoinOutcome } from './server/db/roster';

async function asMember(groupDid: string) {
	const ctx = await groupRequestContext(groupDid);
	return { ...ctx, member: await callerSession(getRequestEvent().locals.session) };
}

export const joinGroupForm = form(
	v.object({
		groupDid: didField,
		message: v.optional(v.pipe(v.string(), v.maxLength(1000)))
	}),
	async (data): Promise<GroupFormResult<{ outcome: JoinOutcome }>> => {
		const ctx = await asMember(data.groupDid);
		try {
			const outcome = await (await groupHost(ctx)).requestJoin(ctx, data.message || null);
			return { ok: true, outcome };
		} catch (e) {
			return formError(e);
		}
	}
);

/** A new sign-in, for a member whose sign-in carries no grant for groups. */
export const signInForGroup = command(v.object({ groupDid: didField }), async (data) => {
	const ctx = await groupRequestContext(data.groupDid, { signInNotice: true });
	const { url } = await authorizeSignIn(ctx.env, {
		target: { type: 'account', identifier: ctx.callerDid as Did }
	});
	return url.toString();
});

/** Leave, or withdraw a pending request: for the applicant, the same intent. */
export const leaveGroupForm = form(
	v.object({ groupDid: didField }),
	async (data): Promise<GroupFormResult<{ outcome: 'withdrawn' | 'left' }>> => {
		const ctx = await asMember(data.groupDid);
		try {
			const host = await groupHost(ctx);
			// A pending applicant has no membership: only the request closes.
			if (ctx.membership.pendingRequestId) {
				await host.cancelJoinRequest(ctx);
				return { ok: true, outcome: 'withdrawn' };
			}
			await host.leaveGroup(ctx);
			return { ok: true, outcome: 'left' };
		} catch (e) {
			return formError(e);
		}
	}
);

export const approveJoinRequestForm = form(
	v.object({
		groupDid: didField,
		member: didField,
		role: v.optional(assignableRoleField)
	}),
	async (data): Promise<GroupFormResult> => {
		const ctx = await groupRequestContext(data.groupDid);
		if (!can(ctx.membership.permissions, 'ADMIT_MEMBERS')) {
			return notAllowed(ctx.membership, 'ADMIT_MEMBERS');
		}
		try {
			await (await groupHost(ctx)).approveJoinRequest(ctx, data.member, data.role ?? 'member');
			return { ok: true };
		} catch (e) {
			return formError(e);
		}
	}
);

export const rejectJoinRequestForm = form(
	v.object({ groupDid: didField, member: didField }),
	async (data): Promise<GroupFormResult> => {
		const ctx = await groupRequestContext(data.groupDid);
		if (!can(ctx.membership.permissions, 'ADMIT_MEMBERS')) {
			return notAllowed(ctx.membership, 'ADMIT_MEMBERS');
		}
		try {
			await (await groupHost(ctx)).denyJoinRequest(ctx, data.member);
			return { ok: true };
		} catch (e) {
			return formError(e);
		}
	}
);

/** A handle is resolved after the permission check; the roster records the DID. */
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
			await (await groupHost(ctx)).addMember(ctx, did, data.role ?? 'member');
			return { ok: true };
		} catch (e) {
			return formError(e);
		}
	}
);

export const removeMemberForm = form(
	v.object({ groupDid: didField, did: didField }),
	async (data): Promise<GroupFormResult> => {
		const ctx = await groupRequestContext(data.groupDid);
		if (!can(ctx.membership.permissions, 'EJECT_MEMBERS')) {
			return notAllowed(ctx.membership, 'EJECT_MEMBERS');
		}
		try {
			await (await groupHost(ctx)).ejectMember(ctx, data.did);
			return { ok: true };
		} catch (e) {
			return formError(e);
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
			await (await groupHost(ctx)).setMemberRole(ctx, data.did, data.role);
			return { ok: true };
		} catch (e) {
			return formError(e);
		}
	}
);
