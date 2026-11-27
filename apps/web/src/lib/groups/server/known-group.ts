// Whether an account is a group this site knows, for a person's profile address that names one:
// the profile page sends it on to the group's page. Read from what is here, with no call to any other
// server, so an ordinary profile costs one look in the index, and nothing with groups off.
import { isDeclared } from './group';
import { groupsEnabled } from './enabled';
import { hasGroupSession } from './sign-in';

/** False with groups off, before anything is read. Known by its declaration in the index, or by a
 *  link to it the viewer holds here. Never throws: a profile does not fail over a group lookup. */
export async function isKnownGroup(did: string, viewerDid: string | null): Promise<boolean> {
	if (!groupsEnabled()) return false;
	try {
		if (await isDeclared(did)) return true;
	} catch (e) {
		console.warn(`[groups] ${did}: the declaration could not be read for a profile:`, e);
	}
	if (!viewerDid) return false;
	return hasGroupSession(did, viewerDid).catch((e) => {
		console.warn(`[groups] ${did}: the viewer's link could not be read for a profile:`, e);
		return false;
	});
}
