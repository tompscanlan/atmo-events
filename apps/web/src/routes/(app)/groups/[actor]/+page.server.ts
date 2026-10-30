import { env } from 'cloudflare:workers';
import type { ActorIdentifier } from '@atcute/lexicons';
import { getServerClient } from '#lib/contrail/index.js';
import { hostingQuery } from '#lib/contrail/queries.js';
import { groupView } from '#lib/groups/server/context.js';
import { pendingSetup } from '#lib/groups/server/create.js';

const NOTICES = {
	'link=linked': 'Linked. You can now post events for this group.',
	'created=done': 'Your group is ready.',
	'created=stopped': 'Your group was made, but setting it up stopped partway. Finish it below.'
} as const;

export async function load({ params, locals, url }) {
	const group = await groupView(params.actor, locals);
	const page = await hostingQuery(
		getServerClient(env.DB),
		{ actor: group.did as ActorIdentifier },
		null
	);
	const shown = [...url.searchParams].map(([key, value]) => `${key}=${value}`);
	const notice = shown.find((pair): pair is keyof typeof NOTICES => pair in NOTICES);
	const setup = group.linked && locals.did ? await pendingSetup(group.did) : null;
	return {
		pageTitle: group.name,
		pageDescription: group.description ?? `Events from ${group.name}.`,
		group,
		events: page.events,
		cursor: page.cursor,
		signedIn: Boolean(locals.did),
		notice: notice ? NOTICES[notice] : null,
		unfinished: setup !== null && setup.by === locals.did
	};
}
