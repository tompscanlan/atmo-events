// A group's picture, read from its meta space with the viewer's own credential.
//
// The profile that cites it lives in a space, so the blob is a space blob: no
// anonymous `sync.getBlob` serves it, and `space.getBlob` answers only a holder
// the authority lets into meta, and only for a CID a record in meta cites. The
// PDS sends it as an attachment under a sandbox CSP, so a page cannot embed its
// URL, and this app serves the bytes itself.
import { GROUP_AVATAR_MAX_BYTES, GROUP_AVATAR_TYPES } from '../about-record';
import type { GroupRow } from '../types';

import {
	credentialFetch,
	didSpaceHosts,
	type SpaceHolder,
	type SpaceHosts
} from './space-credential';
import { readXrpc, xrpcError } from './xrpc';

const GET_BLOB = 'com.atproto.space.getBlob';

export interface GroupAvatarImage {
	bytes: ArrayBuffer;
	type: string;
}

/** The picture `cid` names, or null when the space does not hold it or what
 *  came back is not an image the profile takes. Throws `SpaceAccessDenied` when
 *  the authority will not let the holder into meta, and on any other failure. */
export async function readGroupAvatar(
	holder: SpaceHolder,
	group: Pick<GroupRow, 'group_did' | 'about_space_uri'>,
	cid: string,
	hosts: SpaceHosts = didSpaceHosts
): Promise<GroupAvatarImage | null> {
	const space = group.about_space_uri;
	if (!space) return null;
	const repo = group.group_did;
	const res = await credentialFetch(holder, hosts, space, {
		host: await hosts.repoHost(repo),
		audience: repo,
		nsid: GET_BLOB,
		query: { space, repo, cid }
	});
	if (!res.ok) {
		const answer = await readXrpc(res);
		if (!answer.ok && answer.status === 400 && answer.error === 'BlobNotFound') return null;
		throw xrpcError(GET_BLOB, { status: res.status, error: answer.ok ? null : answer.error });
	}
	const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
	if (!(GROUP_AVATAR_TYPES as readonly string[]).includes(type)) {
		await res.body?.cancel();
		return null;
	}
	const bytes = await res.arrayBuffer();
	return bytes.byteLength > GROUP_AVATAR_MAX_BYTES ? null : { bytes, type };
}
