// A member's RSVP to a members-only event, and its cancel. The page names the
// event, the answer and the version of the event it showed, and nothing else:
// the space, the collection, the key and the subject are the server's to choose
// (./server/member-rsvp.ts), so no input here takes any of them, and the cid is
// only compared. Each resolves the group and the caller's standing as every
// handler does, and the roster gate comes first in the module. A session that
// lacks the grant gets the re-authorize URL back, which the page follows, with
// a marker the page carries back as `asked`. (Spec: FR-113, FR-114, FR-120.)
// ./server/member-rsvp.ts is shared with the e2e harness.
import { command } from '$app/server';
import * as v from 'valibot';
import { askedField, didField, rkeyField, rsvpStatusField } from './form-fields';
import { callerMember, groupRequestContext, reauthorizeUrl, sessionStamp } from './remote-context';
import {
	deleteMembersOnlyRsvp,
	putMembersOnlyRsvp,
	type MembersOnlyRsvpCancel,
	type MembersOnlyRsvpPut
} from './server/member-rsvp';

/** What both commands hand the module about who is asking. */
async function rsvpCaller(groupDid: string, asked: string | null) {
	const ctx = await groupRequestContext(groupDid);
	return {
		ctx,
		target: {
			membership: ctx.membership,
			group: ctx.group,
			member: await callerMember(),
			callerDid: ctx.callerDid,
			stamp: await sessionStamp(),
			asked,
			reauthorize: () => reauthorizeUrl(ctx)
		}
	};
}

export const rsvpToMembersOnlyEvent = command(
	v.object({
		groupDid: didField,
		rkey: rkeyField,
		status: rsvpStatusField,
		cid: v.nullable(v.pipe(v.string(), v.maxLength(200))),
		asked: askedField
	}),
	async (data): Promise<MembersOnlyRsvpPut> => {
		const { ctx, target } = await rsvpCaller(data.groupDid, data.asked);
		return putMembersOnlyRsvp({
			...target,
			rkey: data.rkey,
			status: data.status,
			cid: data.cid,
			groupReader: async () => ctx.reader
		});
	}
);

export const cancelMembersOnlyRsvp = command(
	v.object({ groupDid: didField, rkey: rkeyField, asked: askedField }),
	async (data): Promise<MembersOnlyRsvpCancel> => {
		const { target } = await rsvpCaller(data.groupDid, data.asked);
		return deleteMembersOnlyRsvp({ ...target, rkey: data.rkey });
	}
);
