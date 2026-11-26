// The group host as it describes itself (com.atproto.server.describeServer): its own DID, which a
// person's service auth for it names as the audience, and the domain it gives groups' addresses
// under. Asked of the host rather than set, so a deployment names the host by its URL alone; but
// the DID must be the did:web of that URL's own host, so a host that names another cannot have a
// person's server vouch for them to that other one.
import { fetchOtherServer } from '#lib/spaces/server/other-servers.js';
import { groupHostUrl } from './enabled';
import { answerError, readXrpc } from './xrpc';

export interface GroupHostInfo {
	origin: string;
	/** The host's own DID: always `did:web:<GROUP_HOST_URL's host>`, the audience of each service
	 *  auth for it. */
	did: string;
	/** What a group's address ends in, with its leading dot: `.groups.example`. */
	domain: string;
	/** The host's console page for making a group. The host serves its console at its own address
	 *  unless it is set up elsewhere. */
	newGroupUrl: string;
}

const DESCRIBE_SERVER = 'com.atproto.server.describeServer';
const DESCRIBED_TTL_MS = 10 * 60 * 1000;

let described: { at: number; info: GroupHostInfo } | null = null;

/** The did:web of the group host's own address: its host, with a port's colon encoded. */
export function groupHostDid(url: URL): string {
	return `did:web:${url.host.replace(':', '%3A')}`;
}

/** The group host's DID, from GROUP_HOST_URL alone, with no call to the host; null with groups
 *  off. */
export function configuredGroupHostDid(): string | null {
	const url = groupHostUrl();
	return url ? groupHostDid(url) : null;
}

/** Throws when there is no group host, it does not answer as one, or it names a DID other than
 *  the did:web of its own address. */
export async function groupHostInfo(): Promise<GroupHostInfo> {
	const url = groupHostUrl();
	if (!url) throw new Error('no group host is set');
	const origin = url.origin;
	if (described?.info.origin === origin && Date.now() - described.at < DESCRIBED_TTL_MS) {
		return described.info;
	}
	const answer = await readXrpc(
		await fetchOtherServer(new URL(`/xrpc/${DESCRIBE_SERVER}`, origin), { method: 'GET' })
	);
	if (!answer.ok) throw answerError(DESCRIBE_SERVER, answer);
	const { did, availableUserDomains } = answer.data;
	const domain = Array.isArray(availableUserDomains) ? availableUserDomains[0] : null;
	if (typeof did !== 'string' || !did.startsWith('did:')) {
		throw new Error(`${DESCRIBE_SERVER} at ${origin} names no DID`);
	}
	const own = groupHostDid(url);
	if (did.toLowerCase() !== own.toLowerCase()) {
		const message = `${DESCRIBE_SERVER} at ${origin} names ${did}, not ${own}: nothing is asked of it`;
		console.error(`[groups] ${message}`);
		throw new Error(message);
	}
	if (typeof domain !== 'string' || !/^\.[a-z0-9.-]+$/i.test(domain)) {
		throw new Error(`${DESCRIBE_SERVER} at ${origin} names no domain for groups`);
	}
	const info = { origin, did: own, domain: domain.toLowerCase(), newGroupUrl: `${origin}/new` };
	described = { at: Date.now(), info };
	return info;
}

/** For tests, which change the host between them. */
export function forgetGroupHostInfo(): void {
	described = null;
}
