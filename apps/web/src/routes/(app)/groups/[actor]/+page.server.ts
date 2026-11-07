import { env } from 'cloudflare:workers';
import type { ActorIdentifier } from '@atcute/lexicons';
import { getServerClient } from '#lib/contrail/index.js';
import { hostingQuery } from '#lib/contrail/queries.js';
import type { FlatEventRecord } from '#lib/contrail.js';
import { readMembersOnlyEvents, upcoming } from '#lib/groups/server/calendar-read.js';
import { callerSession } from '#lib/groups/server/caller.js';
import { groupView, type GroupView, type Viewer } from '#lib/groups/server/context.js';
import { pendingSetup } from '#lib/groups/server/create.js';
import { spacesServer } from '#lib/groups/server/group.js';
import { forgetAsked, groupAccess } from '#lib/groups/permissions-asked.js';

const NOTICES = {
	'link=linked': 'Linked. You can now post events for this group.',
	'created=done': 'Your group is ready.',
	'created=stopped': 'Your group was made, but setting it up stopped partway. Finish it below.'
} as const;

/** `notice` says why `events` is empty when they could not be read. */
interface MembersOnlySlice {
	events: FlatEventRecord[];
	notice: string | null;
}

/** Null for a viewer the host does not count a member, or who may not read the space: the
 *  page then shows the public events alone. */
async function membersOnlySlice(
	group: GroupView,
	viewer: Viewer
): Promise<MembersOnlySlice | null> {
	const caller = group.member ? await callerSession(viewer.session ?? null) : null;
	if (!caller) return null;
	try {
		const events = await readMembersOnlyEvents(caller, group.did);
		return events ? { events: upcoming(events), notice: null } : null;
	} catch (e) {
		console.error(`[groups] ${group.did}: members-only events unread for ${caller.did}:`, e);
		return { events: [], notice: "Members-only events couldn't be loaded right now." };
	}
}

export async function load({ params, locals, url, cookies, setHeaders }) {
	// What's on it depends on who's asking, and may be members-only.
	setHeaders({ 'cache-control': 'no-store' });
	const group = await groupView(params.actor, locals);
	if (group.holdsAccess) forgetAsked(cookies);
	const access = groupAccess(group.askAccess, cookies, locals.did);
	const [page, membersOnly] = await Promise.all([
		hostingQuery(getServerClient(env.DB), { actor: group.did as ActorIdentifier }, null),
		membersOnlySlice(group, locals)
	]);
	const shown = [...url.searchParams].map(([key, value]) => `${key}=${value}`);
	const notice = shown.find((pair): pair is keyof typeof NOTICES => pair in NOTICES);
	const setup = group.linked && locals.did ? await pendingSetup(group.did) : null;
	return {
		pageTitle: group.name,
		pageDescription: group.description ?? `Events from ${group.name}.`,
		group,
		events: page.events,
		cursor: page.cursor,
		membersOnly,
		signedIn: Boolean(locals.did),
		you: locals.did ?? null,
		access,
		spacesServer: access === 'refused' ? spacesServer() : null,
		notice: notice ? NOTICES[notice] : null,
		unfinished: setup !== null && setup.by === locals.did
	};
}
