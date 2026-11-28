// A person's own membership: join, ask to join, cancel the request, leave. Each goes to the group
// host as the person (./server/host.ts).
import { error } from '@sveltejs/kit';
import { command, getRequestEvent } from '$app/server';
import * as v from 'valibot';
import { callerSession, type CallerSession } from '#lib/private-events/server/caller.js';
import { JOIN_MESSAGE_MAX } from './fields';
import {
	confirmMembership,
	forgetJoinRequest,
	rememberJoinRequest,
	writeConfirmation
} from './server/confirmation';
import { GROUP_NOT_FOUND } from './server/context';
import { requireGroupsEnabled } from './server/enabled';
import { atGroupHost, resolveGroup } from './server/group';
import {
	cancelJoinRequest,
	GroupActionRefused,
	leaveGroup,
	requestJoin,
	type GroupActionRefusal
} from './server/host';
import { isMemberAsPerson, personReader } from './server/person';
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

/** The person, for an act in a group at this site's group host: anywhere else, nothing is done,
 *  their own confirmation included, and it is the same 404 as a group they may not see. */
async function personIn(groupDid: string): Promise<CallerSession> {
	const caller = await person();
	const group = await resolveGroup(groupDid);
	if (!group || !atGroupHost(group)) error(404, GROUP_NOT_FOUND);
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

/** `joined` for a group open to all, with their confirmation written, since joining is their
 *  act; `pending` for one whose admins decide, with the request noted here, so the first visit
 *  after they are admitted writes it. */
export const joinGroup = command(
	v.object({
		groupDid: didSchema,
		message: v.optional(v.pipe(v.string(), v.maxLength(JOIN_MESSAGE_MAX)))
	}),
	async ({ groupDid, message }) => {
		const caller = await personIn(groupDid);
		const outcome = await atHost(groupDid, () =>
			requestJoin(caller, groupDid, message?.trim() || null)
		);
		if (outcome === 'joined') await confirmMembership(caller, groupDid);
		else {
			await rememberJoinRequest(caller.did, groupDid).catch((e) => {
				console.warn(`[groups] ${caller.did}'s request to ${groupDid} was not noted:`, e);
			});
		}
		return { outcome };
	}
);

export const cancelJoin = command(v.object({ groupDid: didSchema }), async ({ groupDid }) => {
	const caller = await personIn(groupDid);
	await atHost(groupDid, () => cancelJoinRequest(caller, groupDid));
	await forgetJoinRequest(caller.did, groupDid);
	return { ok: true };
});

export const leave = command(v.object({ groupDid: didSchema }), async ({ groupDid }) => {
	const caller = await personIn(groupDid);
	await atHost(groupDid, () => leaveGroup(caller, groupDid));
	await forgetJoinRequest(caller.did, groupDid);
	return { ok: true };
});

const NOT_A_MEMBER = 'The group host does not count you a member of this group.';

/** A member's own confirmation, for one who joined some other way than here: only once the host's
 *  records say they are a member, since a write the host would not count still lands in their
 *  own repo. */
export const confirmMember = command(v.object({ groupDid: didSchema }), async ({ groupDid }) => {
	const caller = await personIn(groupDid);
	const member = await atHost(groupDid, () =>
		isMemberAsPerson(personReader(caller), groupDid, caller.did)
	);
	if (!member) error(409, NOT_A_MEMBER);
	const written = await atHost(groupDid, () => writeConfirmation(caller, groupDid));
	if (written === 'skipped') error(...REFUSED['no-permission']);
	return { ok: true };
});
