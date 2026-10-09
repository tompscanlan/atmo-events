// The e2e's stand-in for `$lib/atproto/methods`, aliased over it in the Vite build
// (groups-e2e.build.mjs). The real module pulls in the app's identity resolver, a
// Svelte module this bundle cannot take. The group pages' gate imports it to turn a
// handle URL into a DID, and the run names its group by DID, so it never asks.

export async function actorToDid(actor: string): Promise<string> {
	throw new Error(`the e2e names groups by DID; it was asked to resolve ${actor}`);
}
