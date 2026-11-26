// A person's own membership: join, ask to join, cancel the request, leave. Each goes to the group
// host as the person (./server/host.ts). And an admin's acts on the members page: admit or deny a
// request, make a member an admin or a member again, and remove one, each as the group through
// the session they linked (./server/roster.ts).
import { error } from '@sveltejs/kit';
import { command, getRequestEvent } from '$app/server';
import * as v from 'valibot';
import { callerSession, type CallerSession } from '#lib/private-events/server/caller.js';
import { JOIN_MESSAGE_MAX } from './fields';
import { GROUP_NOT_FOUND, requireGroupWriter, type GroupWriter } from './server/context';
import { requireGroupsEnabled } from './server/enabled';
import {
	cancelJoinRequest,
	GroupActionRefused,
	leaveGroup,
	requestJoin,
	type GroupActionRefusal
} from './server/host';
import {
	admitMember,
	denyJoinRequest,
	removeMember,
	RosterRefused,
	setMemberAdmin,
	type RosterRefusal
} from './server/roster';
import { errorKind, isLinkBroken, isRoleRefused } from './server/xrpc';

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

/** What the members page shows for each refusal, with its status. */
const ROSTER_REFUSED: Record<RosterRefusal, [400 | 403 | 409, string]> = {
	'last-admin': [
		409,
		'That would leave the group with no admin. Make someone else an admin first.'
	],
	'not-assignable': [403, "Your role in this group doesn't let you give or take that role."],
	'scope-not-held': [403, "Your role in this group doesn't hold what that role would give."],
	'member-role': [
		400,
		'Everyone in a group keeps the member role. To put someone out, remove them.'
	],
	'no-request': [
		409,
		'They are no longer asking to join: they withdrew, or someone else decided already.'
	],
	'already-member': [409, 'They are a member already.'],
	'not-member': [409, 'They are no longer a member.']
};

const NO_ROLE = 'Your role in this group no longer allows that.';
const RELINK = 'Your link to this group stopped working. Link it again from its page.';

/** The caller's own link to the group, or the same 404 as any group they may not see. */
function linked(groupDid: string): Promise<GroupWriter> {
	requireGroupsEnabled();
	return requireGroupWriter(groupDid, getRequestEvent().locals.did);
}

/** As `atHost`, for a write as the group: its refusals in words, a role that no longer allows it
 *  or a broken link as a 403, and any other failure a 502. */
async function asGroup(groupDid: string, run: () => Promise<void>): Promise<{ ok: true }> {
	try {
		await run();
		return { ok: true };
	} catch (e) {
		if (e instanceof RosterRefused) error(...ROSTER_REFUSED[e.reason]);
		if (isRoleRefused(e)) error(403, NO_ROLE);
		if (isLinkBroken(e)) error(403, RELINK);
		console.error(
			`[groups] ${groupDid}: an admin's call to the group host failed: ${errorKind(e)}`
		);
		error(502, 'The group host could not be reached. Try again shortly.');
	}
}

const memberSchema = v.object({ groupDid: didSchema, did: didSchema });

/** Admits someone waiting to join, as a member. */
export const approveRequest = command(memberSchema, async ({ groupDid, did }) => {
	const writer = await linked(groupDid);
	return asGroup(groupDid, () => admitMember(writer, did));
});

export const denyRequest = command(memberSchema, async ({ groupDid, did }) => {
	const writer = await linked(groupDid);
	return asGroup(groupDid, () => denyJoinRequest(writer, did));
});

/** Makes a member an admin, or an admin a member again; any other role they hold stays. */
export const changeRole = command(
	v.object({ groupDid: didSchema, did: didSchema, admin: v.boolean() }),
	async ({ groupDid, did, admin: makeAdmin }) => {
		const writer = await linked(groupDid);
		// Their membership is read with their own access, as a member.
		const caller = await person();
		return asGroup(groupDid, () => setMemberAdmin(writer, caller, did, makeAdmin));
	}
);

export const removeFromGroup = command(memberSchema, async ({ groupDid, did }) => {
	const writer = await linked(groupDid);
	return asGroup(groupDid, () => removeMember(writer, did));
});
