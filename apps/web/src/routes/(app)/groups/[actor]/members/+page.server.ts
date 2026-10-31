import { error } from '@sveltejs/kit';
import { callerSession } from '#lib/groups/server/caller.js';
import { GROUP_NOT_FOUND, groupView, requireGroupWriter } from '#lib/groups/server/context.js';
import { spacesServer } from '#lib/groups/server/group.js';
import { listJoinRequests, type JoinRequest } from '#lib/groups/server/host.js';
import { splitRoster } from '#lib/groups/server/members-read.js';
import { handlesOf, readRoster } from '#lib/groups/server/roster.js';
import { isSpaceAccessDenied } from '#lib/groups/server/space-credential.js';

export async function load({ params, locals }) {
	const group = await groupView(params.actor, locals);
	const caller = await callerSession(locals.session);
	const base = {
		pageTitle: `Members - ${group.name}`,
		group: { did: group.did, name: group.name }
	};
	// Someone who can see the group but holds no group permissions, perhaps because their server
	// cannot grant them: say how to get them, instead of answering that there is no group.
	if (!group.personal && caller && group.askAccess) {
		return {
			...base,
			hidden: true as const,
			needsAccess: true as const,
			spacesServer: spacesServer()
		};
	}
	// Only someone the host lets read the group can be let read its roster.
	if (!group.personal || !caller) error(404, GROUP_NOT_FOUND);

	let roster;
	try {
		roster = await readRoster(caller, group.did);
	} catch (e) {
		if (isSpaceAccessDenied(e))
			return { ...base, hidden: true as const, needsAccess: false as const };
		throw e;
	}

	// Managing the roster writes as the group, so it needs the caller's linked session too.
	const may = (permission: string) =>
		Boolean(group.linked) && roster.permissions.includes(permission as never);
	const manage = {
		admit: may('ADMIT_MEMBERS'),
		eject: may('EJECT_MEMBERS'),
		assign: may('ASSIGN_ROLES')
	};
	let requests: JoinRequest[] | null = null;
	if (manage.admit) {
		const writer = await requireGroupWriter(group.did, locals.did);
		requests = await listJoinRequests(writer).catch((e) => {
			console.warn(`[groups] ${group.did}: join requests could not be listed:`, e);
			return null;
		});
	}

	const { listed, unconfirmed } = splitRoster(roster.entries);
	const seesUnconfirmed = roster.permissions.includes('ADMIT_MEMBERS');
	const shown = [...listed, ...(seesUnconfirmed ? unconfirmed : []), ...(requests ?? [])].map(
		(entry) => entry.did
	);
	return {
		...base,
		hidden: false as const,
		needsAccess: false as const,
		listed,
		unconfirmed: seesUnconfirmed ? unconfirmed : [],
		role: roster.role,
		you: caller.did,
		manage,
		linked: Boolean(group.linked),
		requests,
		handles: await handlesOf(shown)
	};
}
