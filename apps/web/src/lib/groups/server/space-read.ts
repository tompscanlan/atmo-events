// Reads a group's records out of its spaces with the caller's own space credential, so the
// group's host decides what each person sees.
import { spaceRecordUri, splitRecordUri } from '../ids';
import {
	credentialRequest,
	didSpaceHosts,
	type ExchangesUnderWay,
	type SpaceHolder,
	type SpaceHosts
} from './space-credential';
import { answerError, answerIsRecordNotFound, type XrpcAnswer } from './xrpc';

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

const LIST_RECORDS_LIMIT = 100;

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

// `getRecord` returns `uri` without `collection` and `rkey`, and `listRecords` the reverse.
function toSpaceRecord(
	body: unknown,
	from: { space: string; repo: string }
): GroupSpaceRecord | null {
	if (!body || typeof body !== 'object') return null;
	const cid = 'cid' in body && typeof body.cid === 'string' ? body.cid : '';
	const value = asRecord('value' in body ? body.value : null);

	const listed = {
		collection: 'collection' in body && typeof body.collection === 'string' ? body.collection : '',
		rkey: 'rkey' in body && typeof body.rkey === 'string' ? body.rkey : ''
	};
	if (listed.collection && listed.rkey) {
		return {
			uri: spaceRecordUri(from.space, from.repo, listed.collection, listed.rkey),
			cid,
			collection: listed.collection,
			rkey: listed.rkey,
			value
		};
	}

	if (!('uri' in body) || typeof body.uri !== 'string') return null;
	const { collection, rkey } = splitRecordUri(body.uri);
	return { uri: body.uri, cid, collection, rkey, value };
}

type SpaceQuery = (nsid: string, params: Record<string, string>) => Promise<XrpcAnswer>;

function readerOver(query: SpaceQuery): GroupSpaceReader {
	const send = async (nsid: string, params: Record<string, string>) => {
		const answer = await query(nsid, params);
		// RecordNotFound is the only 400 that means absent. Anything else throws, so a gate
		// fails closed rather than read "no records".
		if (answerIsRecordNotFound(answer)) return null;
		if (!answer.ok) throw answerError(nsid, answer);
		return answer.data;
	};

	return {
		async get(query) {
			return toSpaceRecord(await send('com.atproto.space.getRecord', query), query);
		},
		async list(query) {
			const records: GroupSpaceRecord[] = [];
			let cursor: string | undefined;
			for (;;) {
				const body = await send('com.atproto.space.listRecords', {
					space: query.space,
					repo: query.repo,
					...(query.collection ? { collection: query.collection } : {}),
					limit: String(LIST_RECORDS_LIMIT),
					...(cursor ? { cursor } : {})
				});
				const page = body && Array.isArray(body.records) ? body.records : null;
				if (!page) {
					if (cursor) throw new Error('com.atproto.space.listRecords returned no records page');
					return records;
				}
				for (const record of page) {
					const parsed = toSpaceRecord(record, query);
					if (parsed) records.push(parsed);
				}
				const next = typeof body?.cursor === 'string' ? body.cursor : undefined;
				if (!next || page.length === 0) return records;
				if (next === cursor) throw new Error('com.atproto.space.listRecords repeated its cursor');
				cursor = next;
			}
		}
	};
}

/** A space the holder may not read throws `SpaceAccessDenied`: no access, not an outage. */
export function credentialSpaceReader(
	holder: SpaceHolder,
	hosts: SpaceHosts = didSpaceHosts
): GroupSpaceReader {
	// One reader per request, so its reads share exchanges only there.
	const underWay: ExchangesUnderWay = new Map();
	return readerOver(async (nsid, params) => {
		const call = {
			host: await hosts.repoHost(params.repo),
			audience: params.repo,
			nsid,
			query: params
		};
		return credentialRequest(holder, hosts, params.space, call, underWay);
	});
}
