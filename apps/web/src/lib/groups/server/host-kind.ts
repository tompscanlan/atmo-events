// Which groups live at a real group host: those whose DID document names, as
// their PDS, the host this deployment is set up with (`GROUP_HOST_URL`). Every
// other group is the stand-in host's (./host.ts).
import type { CredentialStoreEnv } from './session';
import { didSpaceHosts, type SpaceHosts } from './space-credential';

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
