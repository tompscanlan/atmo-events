// A group's handle, asked of the group's own PDS and checked both ways before it
// is cached (./identities.ts) and shown.
import { Client, simpleFetchHandler } from '@atcute/client';
import type { Did } from '@atcute/lexicons';
import { getPDS } from '$lib/atproto/methods';
import { registerGroupIdentity } from './identities';

/** Reads the handle the group's PDS reports and caches it. A handle that fails the
 *  two-way check (`handleIsCorrect`) is not shown, since an unverified handle is a
 *  takeover risk. Returns null when the PDS cannot be asked; the caller shows the DID. */
export async function refreshGroupHandle(db: D1Database, groupDid: string): Promise<string | null> {
	let service: string | null;
	try {
		service = (await getPDS(groupDid as Did)) ?? null;
	} catch {
		return null;
	}
	if (!service) return null;

	const client = new Client({ handler: simpleFetchHandler({ service }) });
	const res = await client.get('com.atproto.repo.describeRepo', {
		params: { repo: groupDid as Did }
	});
	if (!res.ok) return null;
	if (!res.data.handleIsCorrect) return null;
	const handle = res.data.handle;

	await registerGroupIdentity(db, { did: groupDid, handle, pds: service });
	return handle;
}
