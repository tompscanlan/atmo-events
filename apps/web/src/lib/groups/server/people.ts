// Who a DID is, for display: avatar, display name and handle, from the profile
// lookup the rest of the app uses (`loadProfile`, which asks Contrail and fetches a
// profile it has not indexed yet). Nothing keys on the result; links and forms keep
// the DID.
import type { Did } from '@atcute/lexicons';
import { loadProfile } from '$lib/atproto/server/profile';
import type { Person } from '../types';

/** Every DID's `Person`, keyed by DID. A DID whose lookup fails still gets an
 *  entry, with no handle, so the page shows the DID. */
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
