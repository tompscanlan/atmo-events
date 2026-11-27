import { error } from '@sveltejs/kit';
import { groupAccess } from '#lib/groups/permissions-asked.js';
import type { JoinRequestView } from '#lib/groups/roster.js';
import {
	GROUP_UNCHECKED,
	groupView,
	MEMBERS_ONLY,
	requireGroupWriter
} from '#lib/groups/server/context.js';
import { requireGroupsEnabled } from '#lib/groups/server/enabled.js';
import { listJoinRequests, readRoster } from '#lib/groups/server/roster.js';
import { errorKind } from '#lib/groups/server/xrpc.js';
import { callerSession } from '#lib/private-events/server/caller.js';
import { spacesServer } from '#lib/private-events/server/enabled.js';
import { isSpaceAccessDenied } from '#lib/spaces/server/space-credential.js';

// Who is in the group, for its members, read with their own access. An admin who linked the group
// also gets the waiting requests and the controls, as far as the link's granted scope reaches.
export async function load({ params, locals, url, setHeaders }) {
	requireGroupsEnabled();
	setHeaders({ 'cache-control': 'no-store' });
	const person = locals.did ? await callerSession(locals.session ?? null) : null;
	const group = await groupView(params.actor, locals.did, person);
	const base = {
		pageTitle: `Members - ${group.name}`,
		group: { did: group.did, name: group.name },
		you: locals.did
	};

	// Their own sign-in lacks the group permissions: say how to get them, or that their server has
	// no spaces.
	const access = group.askAccess && person ? groupAccess(url, person.did) : null;
	if (access) {
		const server = access === 'refused' ? spacesServer() : null;
		return { ...base, state: 'access' as const, access, spacesServer: server };
	}
	if (!person || !group.member) {
		if (group.personal && group.member === null) error(503, GROUP_UNCHECKED);
		return { ...base, state: 'hidden' as const, message: MEMBERS_ONLY };
	}

	let roster;
	try {
		// Their own confirmation as the group read for them found it, or read with the rest.
		roster = await readRoster(person, group.did, group.confirmed ?? null);
	} catch (e) {
		if (isSpaceAccessDenied(e)) return { ...base, state: 'hidden' as const, message: MEMBERS_ONLY };
		console.error(`[groups] ${group.did}: the roster could not be read: ${errorKind(e)}`);
		error(503, GROUP_UNCHECKED);
	}

	const can = group.linked?.can;
	const manage = {
		admit: Boolean(can?.admit),
		assign: Boolean(can?.assign),
		remove: Boolean(can?.remove)
	};
	let requests: JoinRequestView[] | null = null;
	if (manage.admit) {
		const writer = await requireGroupWriter(group.did, locals.did);
		requests = await listJoinRequests(writer).catch((e: unknown) => {
			console.warn(`[groups] ${group.did}: the join requests could not be listed: ${errorKind(e)}`);
			return null;
		});
	}
	// Someone who may admit sees who has not confirmed yet; everyone else sees only the confirmed.
	const listed = roster.entries.filter((entry) => entry.confirmed !== false);
	const unconfirmed = manage.admit
		? roster.entries.filter((entry) => entry.confirmed === false)
		: [];
	return {
		...base,
		state: 'roster' as const,
		listed,
		unconfirmed,
		roles: roster.roles,
		yours: roster.yours,
		manage,
		requests,
		/** A link approved before atmo asked for the members page: approving again may bring it. */
		reapprove: Boolean(group.linked?.reapprove) && !manage.admit && !manage.assign && !manage.remove
	};
}
