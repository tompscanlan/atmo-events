import { error } from '@sveltejs/kit';
import { canSeeGroup } from '$lib/groups/access';
import { can } from '$lib/groups/permissions';
import { listGroupEvents } from '$lib/groups/server/events-read';
import { getCallerMembership, getGroupBySlug } from '$lib/groups/server/repo';
import type { PageServerLoad } from './$types';

/** The group's PUBLIC event slice, read straight from the group DID's repo with
 *  no credential — so this page renders for a visitor who has never logged in.
 *  A network failure at the PDS degrades to an empty list rather than a 500:
 *  the group itself still has a page worth showing. */
export const load: PageServerLoad = async ({ params, locals, platform }) => {
	const db = platform!.env.DB;
	const group = await getGroupBySlug(db, params.slug);
	if (!group) error(404, 'Group not found');

	const membership = await getCallerMembership(db, group.id, locals.did);
	// One gate, not two: a private group 404s for anyone off its roster, and
	// after FR-005d the events question had become the same membership test.
	if (!canSeeGroup(group, membership)) error(404, 'Group not found');

	const events = await listGroupEvents(platform!.env, group).catch((e) => {
		console.error(`[groups] listGroupEvents failed for ${group.slug}:`, e);
		return [];
	});

	return {
		group,
		membership,
		events,
		canCreateEvent: can(membership.permissions, 'CREATE_EVENT'),
		canManageEvents: can(membership.permissions, 'MANAGE_EVENTS')
	};
};
