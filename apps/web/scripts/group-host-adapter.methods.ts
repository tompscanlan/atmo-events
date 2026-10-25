// The devnet probe bundle's replacement for `$lib/atproto/methods`, aliased over it in
// ./group-host-adapter.build.mjs. The real module pulls in the app's sign-in state, a
// Svelte module this bundle cannot take. A create's handle refresh asks it for the
// group's PDS and shows the DID when it cannot answer, so this never answers.

export async function getPDS(did: string): Promise<string | undefined> {
	throw new Error(`the probe bundle resolves no PDS; it was asked for ${did}`);
}

export async function actorToDid(actor: string): Promise<string> {
	throw new Error(`the probe bundle names groups by DID; it was asked to resolve ${actor}`);
}
