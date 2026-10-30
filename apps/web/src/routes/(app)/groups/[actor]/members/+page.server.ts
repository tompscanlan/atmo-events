import { error } from '@sveltejs/kit';
import { callerSession } from '#lib/groups/server/caller.js';
import { GROUP_NOT_FOUND, groupView } from '#lib/groups/server/context.js';
import { splitRoster } from '#lib/groups/server/members-read.js';
import { handlesOf, readRoster } from '#lib/groups/server/roster.js';
import { isSpaceAccessDenied } from '#lib/groups/server/space-credential.js';

export async function load({ params, locals }) {
	const group = await groupView(params.actor, locals);
	const caller = await callerSession(locals.session);
	// Only someone the host lets read the group can be let read its roster.
	if (!group.personal || !caller) error(404, GROUP_NOT_FOUND);

	const base = {
		pageTitle: `Members - ${group.name}`,
		group: { did: group.did, name: group.name }
	};
	let roster;
	try {
		roster = await readRoster(caller, group.did);
	} catch (e) {
		if (isSpaceAccessDenied(e)) return { ...base, hidden: true as const };
		throw e;
	}

	const { listed, unconfirmed } = splitRoster(roster.entries);
	const seesUnconfirmed = roster.permissions.includes('ADMIT_MEMBERS');
	const shown = seesUnconfirmed ? [...listed, ...unconfirmed] : listed;
	return {
		...base,
		hidden: false as const,
		listed,
		unconfirmed: seesUnconfirmed ? unconfirmed : [],
		role: roster.role,
		handles: await handlesOf(shown.map((entry) => entry.did))
	};
}
