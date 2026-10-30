import { error } from '@sveltejs/kit';
import { command, getRequestEvent } from '$app/server';
import * as v from 'valibot';
import { RSVP_STATUSES } from './ids';
import { callerSession, type CallerSession } from './server/caller';
import { deleteMembersOnlyRsvp, putMembersOnlyRsvp, RsvpRefused } from './server/member-rsvp';

const didSchema = v.pipe(v.string(), v.regex(/^did:[a-z]+:[a-zA-Z0-9._:%-]{1,2048}$/));
const rkeySchema = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9._:~-]{1,512}$/));

async function member(): Promise<CallerSession> {
	const caller = await callerSession(getRequestEvent().locals.session);
	if (!caller) error(401, 'Sign in first');
	return caller;
}

/** A refusal in its own words, which the page shows; it never reads as saved. */
async function rsvp(run: () => Promise<void>): Promise<{ ok: true }> {
	try {
		await run();
		return { ok: true };
	} catch (e) {
		if (e instanceof RsvpRefused) error(409, e.message);
		throw e;
	}
}

export const rsvpToMembersOnlyEvent = command(
	v.object({
		groupDid: didSchema,
		rkey: rkeySchema,
		status: v.picklist(RSVP_STATUSES),
		cid: v.nullable(v.string())
	}),
	async ({ groupDid, ...input }) => {
		const caller = await member();
		return rsvp(() => putMembersOnlyRsvp(caller, groupDid, input));
	}
);

export const cancelMembersOnlyRsvp = command(
	v.object({ groupDid: didSchema, rkey: rkeySchema }),
	async ({ groupDid, rkey }) => {
		const caller = await member();
		return rsvp(() => deleteMembersOnlyRsvp(caller, groupDid, rkey));
	}
);
