// The e2e's stand-in for `$lib/atproto/methods`, aliased over it in the Vite build
// (groups-e2e.build.mjs). The real module pulls in the app's identity resolver, a
// Svelte module this bundle cannot take. The group pages' gate imports it to turn a
// handle URL into a DID, and the run names its group by DID, so it never asks. A
// group's handle check asks it for the group's PDS, which is read from the devnet's
// PLC, as everything here is (./groups-e2e.identity-resolver.ts).
import type { Did } from '@atcute/lexicons';
import { PlcDidDocumentResolver } from '@atcute/identity-resolver';

export async function actorToDid(actor: string): Promise<string> {
	throw new Error(`the e2e names groups by DID; it was asked to resolve ${actor}`);
}

const plc = new PlcDidDocumentResolver();

export async function getPDS(did: Did) {
	const doc = await plc.resolve(did as Did<'plc'>);
	return doc.service?.find((service) => service.id === '#atproto_pds')?.serviceEndpoint.toString();
}
