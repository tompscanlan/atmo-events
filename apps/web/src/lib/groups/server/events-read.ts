// Reading a group's PUBLIC event slice.
//
// Straight off the group DID's PDS with no credential: a repo's records are
// anonymously readable, which is exactly why the public slice lives there
// rather than in the group's space (a space refuses anonymous HTTP even under a
// public policy — measured, 401 AuthMissing). So /groups/<slug>/events renders
// for a visitor who has never logged in.
//
// Not routed through contrail: contrail only indexes DIDs in its identities
// table, and a freshly bound group DID is not one until it is backfilled. The
// repo is the source of truth either way.
import { Client, simpleFetchHandler } from '@atcute/client';
import type { Did } from '@atcute/lexicons';
import { getPDS } from '$lib/atproto/methods';
import type { GroupEventRecord, GroupRow } from '../types';
import { credentialFor } from './credentials';
import { GROUP_EVENT_COLLECTION } from './event-writer';

/** The group's PDS base URL. Taken from the OPERATOR-CONFIGURED credential when
 *  there is one (no network hop, and it is the same PDS the writer authenticates
 *  against), otherwise resolved from the DID document.
 *
 *  A MINTED group takes the second path by design: its credential lives
 *  encrypted in `group_credentials`, and this function needs only a service URL
 *  — for which the DID document is the authority, and which needs no credential
 *  and no decryption key. Threading the database in here to save one hop would
 *  buy nothing a resolver call does not already give. */
export async function groupPdsUrl(
	env: { GROUP_CREDENTIALS?: string },
	group: GroupRow
): Promise<string | null> {
	const cred = credentialFor(env, group.group_did);
	if (cred) return cred.service;
	try {
		return (await getPDS(group.group_did as Did)) ?? null;
	} catch {
		return null;
	}
}

export async function listGroupEvents(
	env: { GROUP_CREDENTIALS?: string },
	group: GroupRow,
	limit = 50
): Promise<GroupEventRecord[]> {
	const service = await groupPdsUrl(env, group);
	if (!service) return [];

	const client = new Client({ handler: simpleFetchHandler({ service }) });
	const res = await client.get('com.atproto.repo.listRecords', {
		params: {
			repo: group.group_did as Did,
			collection: GROUP_EVENT_COLLECTION,
			limit: Math.min(Math.max(limit, 1), 100)
		}
	});
	if (!res.ok) return [];

	return res.data.records.map((record) => ({
		uri: record.uri,
		cid: record.cid ?? '',
		rkey: record.uri.slice(record.uri.lastIndexOf('/') + 1),
		value: record.value as Record<string, unknown>
	}));
}

export async function getGroupEvent(
	env: { GROUP_CREDENTIALS?: string },
	group: GroupRow,
	rkey: string
): Promise<GroupEventRecord | null> {
	const service = await groupPdsUrl(env, group);
	if (!service) return null;

	const client = new Client({ handler: simpleFetchHandler({ service }) });
	const res = await client.get('com.atproto.repo.getRecord', {
		params: {
			repo: group.group_did as Did,
			collection: GROUP_EVENT_COLLECTION,
			rkey
		}
	});
	if (!res.ok) return null;

	return {
		uri: res.data.uri,
		cid: res.data.cid ?? '',
		rkey,
		value: res.data.value as Record<string, unknown>
	};
}
