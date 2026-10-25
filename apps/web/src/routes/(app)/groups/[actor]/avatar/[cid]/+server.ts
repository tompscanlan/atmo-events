import { error } from '@sveltejs/kit';
import { gateCaller } from '$lib/groups/server/caller';
import { readGroupAvatar } from '$lib/groups/server/avatar-read';
import { getGroupByDid } from '$lib/groups/server/db/groups';
import { holdsMetaRead } from '$lib/groups/server/member-grants';
import { GROUP_NOT_FOUND, groupActorToDid } from '$lib/groups/server/route-context';
import { isSpaceAccessDenied } from '$lib/groups/server/space-credential';
import type { RequestHandler } from './$types';

/** A CID as a blob reference names one: base32, lowercase. */
const CID_PATTERN = /^b[a-z2-7]{20,100}$/;

// A group's picture (lib/groups/server/avatar-read.ts), read with the viewer's
// own access, so whoever may read the group's meta space sees it and nobody else
// does. Every refusal is the same 404 the group routes give. The CID is in the
// path, so a new picture is a new URL and a cached one never goes stale.
export const GET: RequestHandler = async ({ params, locals, platform }) => {
	if (!CID_PATTERN.test(params.cid)) error(404, GROUP_NOT_FOUND);
	const did = await groupActorToDid(params.actor);
	const group = did ? await getGroupByDid(platform!.env.DB, did) : null;
	if (!group) error(404, GROUP_NOT_FOUND);

	const caller = await gateCaller(locals.did, locals.session);
	if (!caller || !holdsMetaRead(caller.scope)) error(404, GROUP_NOT_FOUND);

	let image;
	try {
		image = await readGroupAvatar(caller, group, params.cid);
	} catch (e) {
		if (isSpaceAccessDenied(e)) error(404, GROUP_NOT_FOUND);
		console.error(`[groups] ${group.group_did}: reading its picture failed:`, e);
		error(502, 'The group picture could not be read');
	}
	if (!image) error(404, GROUP_NOT_FOUND);

	return new Response(image.bytes, {
		headers: {
			'content-type': image.type,
			// Per viewer, since what they may read is theirs: never a shared cache.
			'cache-control': 'private, max-age=3600',
			'x-content-type-options': 'nosniff',
			'content-security-policy': "default-src 'none'; sandbox"
		}
	});
};
