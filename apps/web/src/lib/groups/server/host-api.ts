// The group host as it describes itself (com.atproto.server.describeServer): its own DID, which a
// person's service auth for it names as the audience, and the domain it gives groups' addresses
// under. Asked of the host rather than set, so a deployment names the host by its URL alone.
import { fetchOtherServer } from '#lib/spaces/server/other-servers.js';
import { groupHostOrigin } from './group';
import { answerError, readXrpc } from './xrpc';

export interface GroupHostInfo {
	origin: string;
	/** The host's own DID, its `SERVICE_DID`: `did:web:<its domain>` unless it sets another. */
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

/** Throws when there is no group host, or it does not answer as one. */
export async function groupHostInfo(): Promise<GroupHostInfo> {
	const origin = groupHostOrigin();
	if (!origin) throw new Error('no group host is set');
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
	if (typeof domain !== 'string' || !/^\.[a-z0-9.-]+$/i.test(domain)) {
		throw new Error(`${DESCRIBE_SERVER} at ${origin} names no domain for groups`);
	}
	const info = { origin, did, domain: domain.toLowerCase(), newGroupUrl: `${origin}/new` };
	described = { at: Date.now(), info };
	return info;
}

/** For tests, which change the host between them. */
export function forgetGroupHostInfo(): void {
	described = null;
}
