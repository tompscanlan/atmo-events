import { env } from 'cloudflare:workers';
import type { ActorIdentifier } from '@atcute/lexicons';
import { getServerClient } from '#lib/contrail/index.js';
import { hostingQuery } from '#lib/contrail/queries.js';
import { groupView } from '#lib/groups/server/context.js';

const LINK_NOTICES = {
	linked: 'Linked. You can now post events for this group.'
} as const;

export async function load({ params, locals, url }) {
	const group = await groupView(params.actor, locals);
	const page = await hostingQuery(
		getServerClient(env.DB),
		{ actor: group.did as ActorIdentifier },
		null
	);
	const link = url.searchParams.get('link');
	return {
		pageTitle: group.name,
		pageDescription: group.description ?? `Events from ${group.name}.`,
		group,
		events: page.events,
		cursor: page.cursor,
		signedIn: Boolean(locals.did),
		notice: link && link in LINK_NOTICES ? LINK_NOTICES[link as keyof typeof LINK_NOTICES] : null
	};
}
