// Which groups live at this deployment's group host: those whose DID document
// names, as their PDS, the host it is set up with (`GROUP_HOST_URL`). This site
// changes no other group (./host.ts).
import type { CredentialStoreEnv } from './session';
import { didSpaceHosts, type SpaceHosts } from './space-credential';

/** The group is not at the group host this deployment is set up with, so this
 *  site cannot change it: it changes a group only through its host. Thrown
 *  before any request. */
export class GroupNotAtHostError extends Error {
	constructor(readonly groupDid: string) {
		super(`${groupDid} is not at this site's group host, so this site cannot change it`);
		this.name = 'GroupNotAtHostError';
	}
}

/** The group host this deployment is set up with, by origin, or null. */
export function groupHostOrigin(
	env: Pick<CredentialStoreEnv, 'GROUP_HOST_URL'> | undefined
): string | null {
	const url = env?.GROUP_HOST_URL?.trim();
	return url ? new URL(url).origin : null;
}

/** Whether `groupDid` lives at this deployment's group host: its DID document
 *  names the host as its PDS. With no host set up, no group does, and nothing is
 *  resolved. A DID that cannot be resolved throws: which host serves a group is
 *  not something to guess. */
export async function isHostGroup(
	env: Pick<CredentialStoreEnv, 'GROUP_HOST_URL'> | undefined,
	groupDid: string,
	hosts: Pick<SpaceHosts, 'repoHost'> = didSpaceHosts
): Promise<boolean> {
	const origin = groupHostOrigin(env);
	if (!origin) return false;
	return new URL(await hosts.repoHost(groupDid)).origin === origin;
}
