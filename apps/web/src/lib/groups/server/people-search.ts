// Handle suggestions from what this deployment's index already holds: Contrail's
// `identities` (every account it has resolved) and the profiles it has indexed. No
// outside service sees what an admin types. An account the index has never seen is
// not suggested, and can still be added by its exact handle or DID.
import { getProfileBlobUrl } from '$lib/contrail';
import type { Person } from '../types';

interface MatchRow {
	did: string;
	handle: string;
	record: string | null;
}

/** What a handle prefix may contain. Anything else matches no handle. */
const HANDLE_PREFIX = /^[a-z0-9.-]+$/;

/** The least string above every string that starts with `prefix`, so a prefix
 *  match is a range the handle index serves. */
export function prefixUpperBound(prefix: string): string {
	return prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
}

function toPerson(row: MatchRow): Person {
	let value: { displayName?: unknown; avatar?: unknown } = {};
	try {
		value = row.record ? JSON.parse(row.record) : {};
	} catch {
		// An unreadable profile still leaves the handle to show.
	}
	return {
		did: row.did,
		handle: row.handle,
		displayName:
			typeof value.displayName === 'string' && value.displayName ? value.displayName : null,
		avatar: getProfileBlobUrl(row.did, value.avatar) ?? null
	};
}

/** Accounts whose handle starts with `input`, in handle order. A D1 without the
 *  profile table still matches handles; one without `identities` matches nothing. */
export async function searchPeopleByHandle(
	db: D1Database,
	input: string,
	limit = 6
): Promise<Person[]> {
	const prefix = input.trim().replace(/^@/, '').toLowerCase();
	if (prefix.length < 2 || !HANDLE_PREFIX.test(prefix)) return [];
	const range = `i.handle >= ? AND i.handle < ? AND i.handle != 'handle.invalid'`;
	const queries = [
		`SELECT i.did, i.handle, p.record FROM identities i
		 LEFT JOIN records_profile p ON p.uri = 'at://' || i.did || '/app.bsky.actor.profile/self'
		 WHERE ${range} ORDER BY i.handle LIMIT ?`,
		`SELECT i.did, i.handle, NULL AS record FROM identities i
		 WHERE ${range} ORDER BY i.handle LIMIT ?`
	];
	for (const sql of queries) {
		try {
			const { results } = await db
				.prepare(sql)
				.bind(prefix, prefixUpperBound(prefix), limit)
				.all<MatchRow>();
			return (results ?? []).map(toPerson);
		} catch {
			// A table this D1 was never given. Try with less.
		}
	}
	return [];
}
