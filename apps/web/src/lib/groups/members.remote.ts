// A person's own membership: join, ask to join, cancel the request, leave. Each goes to the group
// host as the person (./server/host.ts); admitting a request is for the group's admins.
import { error } from '@sveltejs/kit';
import { command, getRequestEvent } from '$app/server';
import * as v from 'valibot';
import { callerSession, type CallerSession } from '#lib/private-events/server/caller.js';
import { JOIN_MESSAGE_MAX } from './fields';
import { GROUP_NOT_FOUND } from './server/context';
import { requireGroupsEnabled } from './server/enabled';
import {
	cancelJoinRequest,
	GroupActionRefused,
	leaveGroup,
	requestJoin,
	type GroupActionRefusal
} from './server/host';
import { errorKind } from './server/xrpc';

const didSchema = v.pipe(v.string(), v.regex(/^did:[a-z]+:[a-zA-Z0-9._:%-]{1,2048}$/));

/** What the page shows for each refusal, with its status. */
const REFUSED: Record<GroupActionRefusal, [403 | 404 | 409, string]> = {
	'join-closed': [409, 'This group takes members by invitation only.'],
	'group-not-found': [404, GROUP_NOT_FOUND],
	'last-admin': [
		409,
		"You're the group's only admin, so you can't leave it. Make someone else an admin first."
	],
	'no-permission': [
		403,
		'Your server did not vouch for you to the group host. Allow atmo to act for you in groups first.'
	]
};

async function person(): Promise<CallerSession> {
	requireGroupsEnabled();
	const caller = await callerSession(getRequestEvent().locals.session ?? null);
	if (!caller) error(401, 'Sign in first.');
	return caller;
}

/** A refusal the host gave, in words the page shows; any other failure a 502 that says nothing of
 *  what the host answered. */
async function atHost<T>(groupDid: string, run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (e) {
		if (e instanceof GroupActionRefused) error(...REFUSED[e.reason]);
		console.error(
			`[groups] ${groupDid}: a member's call to the group host failed: ${errorKind(e)}`
		);
		error(502, 'The group host could not be reached. Try again shortly.');
	}
}

/** `joined` for a group open to all; `pending` for one whose admins decide. */
export const joinGroup = command(
	v.object({
		groupDid: didSchema,
		message: v.optional(v.pipe(v.string(), v.maxLength(JOIN_MESSAGE_MAX)))
	}),
	async ({ groupDid, message }) => {
		const caller = await person();
		const outcome = await atHost(groupDid, () =>
			requestJoin(caller, groupDid, message?.trim() || null)
		);
		return { outcome };
	}
);

export const cancelJoin = command(v.object({ groupDid: didSchema }), async ({ groupDid }) => {
	const caller = await person();
	await atHost(groupDid, () => cancelJoinRequest(caller, groupDid));
	return { ok: true };
});

export const leave = command(v.object({ groupDid: didSchema }), async ({ groupDid }) => {
	const caller = await person();
	await atHost(groupDid, () => leaveGroup(caller, groupDid));
	return { ok: true };
});
