// Reads a group's records out of its spaces with the caller's own space credential, so the
// group's host decides what each person sees. The credential and the checked read are lib/spaces';
// what's here is the listing, which only a group's calendar and roster need.
import {
	didSpaceHosts,
	exchangeSpaceCredential,
	fetchWithCredential,
	GET_RECORD,
	spaceAuthority,
	type SpaceCall,
	type SpaceCredential,
	type SpaceHolder,
	type SpaceHosts
} from '#lib/spaces/server/space-credential.js';
import { answerError, answerIsRecordNotFound, readXrpc } from '#lib/spaces/server/xrpc.js';
import { spaceRecordUri } from '../ids';

export interface GroupSpaceRecord {
	uri: string;
	cid: string;
	collection: string;
	rkey: string;
	value: Record<string, unknown>;
}

export interface GroupSpaceReader {
	get(query: {
		space: string;
		repo: string;
		collection: string;
		rkey: string;
	}): Promise<GroupSpaceRecord | null>;
	/** Every page, or a throw: callers act on what is missing, so a partial list never returns. */
	list(query: { space: string; repo: string; collection?: string }): Promise<GroupSpaceRecord[]>;
}

const LIST_RECORDS = 'com.atproto.space.listRecords';
const LIST_RECORDS_LIMIT = 100;

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** A space the holder may not read throws `SpaceAccessDenied`: no access, not an outage. As with
 *  lib/spaces' reader, make one for each request, since it holds its credentials. */
export function credentialSpaceReader(
	holder: SpaceHolder,
	hosts: SpaceHosts = didSpaceHosts
): GroupSpaceReader {
	// By space, so reads that start together share one exchange and a refusal reaches them all.
	const credentials = new Map<string, Promise<SpaceCredential>>();
	const ask = async (space: string, call: SpaceCall) => {
		let credential = credentials.get(space);
		if (!credential) {
			credential = hosts
				.repoHost(spaceAuthority(space))
				.then((authorityHost) => exchangeSpaceCredential(holder, space, authorityHost));
			credentials.set(space, credential);
		}
		return readXrpc(await fetchWithCredential(await credential, hosts, call));
	};

	return {
		async get(query) {
			const answer = await ask(query.space, {
				host: await hosts.repoHost(query.repo),
				audience: query.repo,
				nsid: GET_RECORD,
				query
			});
			// RecordNotFound is the only 400 that means absent. Anything else throws, so a gate
			// fails closed rather than read "no records".
			if (answerIsRecordNotFound(answer)) return null;
			if (!answer.ok) throw answerError(GET_RECORD, answer);
			// `getRecord` returns `uri` without `collection` and `rkey`. The URI, MAC and CID are checked.
			const { uri, cid, value } = answer.data;
			return {
				uri: String(uri),
				cid: String(cid),
				collection: query.collection,
				rkey: query.rkey,
				value: asRecord(value)
			};
		},
		// NOT authenticated: `listRecords` carries no MAC, so nothing here shows these values are the
		// repo's. TS's rule is that every record shown carries one; this stays until the probe's numbers
		// choose between the spec's two patterns.
		async list(query) {
			const records: GroupSpaceRecord[] = [];
			const host = await hosts.repoHost(query.repo);
			let cursor: string | undefined;
			for (;;) {
				const answer = await ask(query.space, {
					host,
					audience: query.repo,
					nsid: LIST_RECORDS,
					query: {
						space: query.space,
						repo: query.repo,
						...(query.collection ? { collection: query.collection } : {}),
						limit: String(LIST_RECORDS_LIMIT),
						...(cursor ? { cursor } : {})
					}
				});
				if (answerIsRecordNotFound(answer)) return records;
				if (!answer.ok) throw answerError(LIST_RECORDS, answer);
				const page = Array.isArray(answer.data.records) ? answer.data.records : null;
				if (!page) {
					if (cursor) throw new Error(`${LIST_RECORDS} returned no records page`);
					return records;
				}
				for (const entry of page) {
					const { collection, rkey, cid, value } = (entry ?? {}) as Record<string, unknown>;
					if (typeof collection !== 'string' || typeof rkey !== 'string') continue;
					records.push({
						uri: spaceRecordUri(query.space, query.repo, collection, rkey),
						cid: typeof cid === 'string' ? cid : '',
						collection,
						rkey,
						value: asRecord(value)
					});
				}
				const next = typeof answer.data.cursor === 'string' ? answer.data.cursor : undefined;
				if (!next || page.length === 0) return records;
				if (next === cursor) throw new Error(`${LIST_RECORDS} repeated its cursor`);
				cursor = next;
			}
		}
	};
}
