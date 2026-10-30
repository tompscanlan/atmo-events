import { error } from '@sveltejs/kit';
import { command, getRequestEvent } from '$app/server';
import * as v from 'valibot';
import { GROUP_ROLES } from './permissions';
import { callerSession, type CallerSession } from './server/caller';
import { requireGroupWriter } from './server/context';
import { resolveGroup } from './server/group';
import {
	admitMember,
	cancelJoinRequest,
	denyJoinRequest,
	GroupActionError,
	leaveGroup,
	removeMember,
	requestJoin,
	setMemberRole
} from './server/host';

const didSchema = v.pipe(v.string(), v.regex(/^did:[a-z]+:[a-zA-Z0-9._:%-]{1,2048}$/));
const roleSchema = v.picklist(GROUP_ROLES);

async function member(): Promise<CallerSession> {
	const caller = await callerSession(getRequestEvent().locals.session);
	if (!caller) error(401, 'Sign in first');
	return caller;
}

/** A refusal the host gave, in words the page shows; anything else is a failure. */
async function host<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (e) {
		if (e instanceof GroupActionError) error(409, e.message);
		throw e;
	}
}

export const joinGroup = command(
	v.object({ groupDid: didSchema, message: v.optional(v.pipe(v.string(), v.maxLength(1000))) }),
	async ({ groupDid, message }) => {
		const caller = await member();
		return { outcome: await host(() => requestJoin(caller, groupDid, message?.trim() || null)) };
	}
);

export const cancelJoin = command(v.object({ groupDid: didSchema }), async ({ groupDid }) => {
	await host(async () => cancelJoinRequest(await member(), groupDid));
	return { ok: true };
});

export const leave = command(v.object({ groupDid: didSchema }), async ({ groupDid }) => {
	await host(async () => leaveGroup(await member(), groupDid));
	return { ok: true };
});

const writerFor = (groupDid: string) => requireGroupWriter(groupDid, getRequestEvent().locals.did);

export const approveRequest = command(
	v.object({ groupDid: didSchema, did: didSchema, role: roleSchema }),
	async ({ groupDid, did, role }) => {
		const writer = await writerFor(groupDid);
		await host(() => admitMember(writer, did, role));
		return { ok: true };
	}
);

export const denyRequest = command(
	v.object({ groupDid: didSchema, did: didSchema }),
	async ({ groupDid, did }) => {
		const writer = await writerFor(groupDid);
		await host(() => denyJoinRequest(writer, did));
		return { ok: true };
	}
);

export const addMember = command(
	v.object({ groupDid: didSchema, actor: v.pipe(v.string(), v.maxLength(2048)), role: roleSchema }),
	async ({ groupDid, actor, role }) => {
		const writer = await writerFor(groupDid);
		const person = await resolveGroup(actor.trim().replace(/^@/, ''));
		if (!person) error(404, 'No account by that handle');
		await host(() => admitMember(writer, person.did, role));
		return { ok: true };
	}
);

export const changeRole = command(
	v.object({ groupDid: didSchema, did: didSchema, role: roleSchema }),
	async ({ groupDid, did, role }) => {
		const writer = await writerFor(groupDid);
		await host(() => setMemberRole(writer, did, role));
		return { ok: true };
	}
);

export const remove = command(
	v.object({ groupDid: didSchema, did: didSchema }),
	async ({ groupDid, did }) => {
		const writer = await writerFor(groupDid);
		await host(() => removeMember(writer, did));
		return { ok: true };
	}
);
