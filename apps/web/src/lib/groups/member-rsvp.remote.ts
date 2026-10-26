// A member's RSVP to a members-only event, and its cancel. The page names the event, the
// answer and the version it showed; the space, collection, key and subject are the server's
// to choose (./server/member-rsvp.ts).
import type { Did } from '@atcute/lexicons';
import { command, getRequestEvent } from '$app/server';
import * as v from 'valibot';
import { didField, rkeyField, rsvpStatusField } from './form-fields';
import { groupRequestContext, type GroupRequestContext } from './remote-context';
import { callerSession } from './server/caller';
import {
	deleteMembersOnlyRsvp,
	putMembersOnlyRsvp,
	type MembersOnlyRsvpCancel,
	type MembersOnlyRsvpPut,
	type MembersOnlyRsvpTarget
} from './server/member-rsvp';
import { authorizeSignIn } from './server/sign-in-grants';

async function reauthorizeUrl(ctx: GroupRequestContext): Promise<string | null> {
	try {
		const { url } = await authorizeSignIn(ctx.env, {
			target: { type: 'account', identifier: ctx.callerDid as Did }
		});
		return url.toString();
	} catch (e) {
		console.error('[groups] a sign-in for the RSVP grant could not be started:', e);
		return null;
	}
}

async function rsvpCaller(groupDid: string, reauthorized: boolean) {
	const ctx = await groupRequestContext(groupDid);
	const target: Omit<MembersOnlyRsvpTarget, 'rkey'> = {
		membership: ctx.membership,
		group: ctx.group,
		member: await callerSession(getRequestEvent().locals.session),
		reauthorized,
		reauthorize: () => reauthorizeUrl(ctx)
	};
	return { ctx, target };
}

export const rsvpToMembersOnlyEvent = command(
	v.object({
		groupDid: didField,
		rkey: rkeyField,
		status: rsvpStatusField,
		cid: v.nullable(v.pipe(v.string(), v.maxLength(200))),
		reauthorized: v.boolean()
	}),
	async (data): Promise<MembersOnlyRsvpPut> => {
		const { ctx, target } = await rsvpCaller(data.groupDid, data.reauthorized);
		return putMembersOnlyRsvp({
			...target,
			rkey: data.rkey,
			status: data.status,
			cid: data.cid,
			reader: async () => ctx.reader
		});
	}
);

export const cancelMembersOnlyRsvp = command(
	v.object({ groupDid: didField, rkey: rkeyField, reauthorized: v.boolean() }),
	async (data): Promise<MembersOnlyRsvpCancel> => {
		const { target } = await rsvpCaller(data.groupDid, data.reauthorized);
		return deleteMembersOnlyRsvp({ ...target, rkey: data.rkey });
	}
);
