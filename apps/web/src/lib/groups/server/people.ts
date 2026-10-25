// Who a DID is, for display only; links and forms keep the DID.
import type { Did } from '@atcute/lexicons';
import { loadProfile } from '$lib/atproto/server/profile';
import type { Person } from '../types';

export async function loadPeople(db: D1Database, dids: string[]): Promise<Record<string, Person>> {
	const unique = [...new Set(dids)];
	const people = await Promise.all(
		unique.map(async (did): Promise<Person> => {
			const profile = await loadProfile(did as Did, db);
			return {
				did,
				// `loadProfile` puts the DID in `handle` when none resolves.
				handle: profile && profile.handle !== did ? profile.handle : null,
				displayName: profile?.displayName || null,
				avatar: profile?.avatar ?? null
			};
		})
	);
	return Object.fromEntries(people.map((person) => [person.did, person]));
}
