// The host line on the page of a public event in a group's repo: the group's name and a link
// to its page for whoever may see the group, and for anyone else its handle with no link.
import { isHttpError } from '@sveltejs/kit';
import type { EventHost } from '@atmo-dev/events-ui';
import { gateCaller } from './caller';
import { getGroupByDid } from './db/groups';
import { knownHandles } from './identities';
import { groupHeader, groupPath, groupRouteContext } from './route-context';
import { groupsEnabled } from './sign-in-grants';

export const PRIVATE_GROUP = 'Private group';

/** Null keeps the account's own line: no group here, or the host cannot say if it is private. */
export async function groupEventHost(
	env: App.Platform['env'],
	authorDid: string,
	locals: Pick<App.Locals, 'did' | 'session'>
): Promise<EventHost | null> {
	if (!groupsEnabled(env) || !(await getGroupByDid(env.DB, authorDid))) return null;
	const viewer = await gateCaller(locals.did, locals.session);
	try {
		const { group, reader } = await groupRouteContext(env.DB, authorDid, viewer, {
			signInNotice: true
		});
		const { groupName } = await groupHeader(env.DB, group, reader);
		return { name: groupName, href: groupPath(group) };
	} catch (e) {
		if (isHttpError(e, 503)) return null;
		if (!isHttpError(e, 404)) throw e;
	}
	const handle = (await knownHandles(env.DB, [authorDid])).get(authorDid);
	return { name: handle ?? authorDid, href: null, note: PRIVATE_GROUP };
}
