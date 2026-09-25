// A group's handle, for display.
//
// The group row carries the DID and no name. The handle is read from the DID
// document and cached in Contrail's `identities` table in this same D1, where
// every other actor's handle on this deployment comes from. A group we have
// never resolved shows its DID. That is not a failure: every link uses the DID.
//
// The `identities` row is written by `./events-index.ts`, because its most
// important column is the PDS, which the index uses to fetch the group's
// records. This module decides what a reader is allowed to see.
//
// This is separate from `repo.ts` because `identities` is Contrail's table, not
// ours. A D1 set up from `migrations/` alone does not have it, so reads here
// tolerate its absence and the groups pages still render. That applies only to
// this display cache: a failed read of a group's records still fails the page.
import { Client, simpleFetchHandler } from '@atcute/client';
import type { Did } from '@atcute/lexicons';
import { getPDS } from '$lib/atproto/methods';
import { registerGroupIdentity } from './events-index';

/** `handle` may be NULL in Contrail's schema, so a row is not a handle. */
interface IdentityRow {
	did: string;
	handle: string | null;
}

/** Handles Contrail already knows, for the DIDs asked about. Missing keys mean
 *  "show the DID", never "the group is broken". */
export async function knownHandles(db: D1Database, dids: string[]): Promise<Map<string, string>> {
	const found = new Map<string, string>();
	if (dids.length === 0) return found;
	const placeholders = dids.map(() => '?').join(', ');
	try {
		const { results } = await db
			.prepare(`SELECT did, handle FROM identities WHERE did IN (${placeholders})`)
			.bind(...dids)
			.all<IdentityRow>();
		for (const row of results ?? []) {
			if (row.handle) found.set(row.did, row.handle);
		}
	} catch {
		// No `identities` table on this database. Display falls back to DIDs.
	}
	return found;
}

/** Reads the handle the group's own PDS reports for it and writes it into
 *  Contrail's cache.
 *
 *  `handleIsCorrect` is the two-way check: the DID document claims the handle,
 *  and the handle resolves back to the DID. A handle that fails it is not
 *  shown. Group URLs carry the DID because an unverified handle is a takeover
 *  risk, and showing one would undo that. When the DID does not resolve to a
 *  PDS, or the PDS refuses describeRepo, this returns null and the caller shows
 *  the DID. */
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
