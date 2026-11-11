import { env } from 'cloudflare:workers';

/** Off unless a deployment turns it on: it needs people on a PDS with spaces support, and the
 *  space type published where their PDS can find it. Turning it back off takes its scopes out of the
 *  sign-in, so anyone who already granted them can't be asked for a new permission, such as Bluesky
 *  posting or meetings, until they sign in again: the OAuth library rejects their requested scopes
 *  as undeclared. */
export function privateEventsEnabled(): boolean {
	return env.PRIVATE_EVENTS === 'true';
}

/** Invitations in atmo, off unless a deployment turns them on as well. Their permissions name the
 *  inbox space type, and a PDS refuses a whole sign-in that names a type it can't find, so with this
 *  on before that type is published nobody could allow private events at all. Off, the sign-in asks
 *  for what it did before invitations, and no inbox is made, written to or read. */
export function invitationsEnabled(): boolean {
	return privateEventsEnabled() && env.PRIVATE_EVENT_INVITATIONS === 'true';
}

/** A PDS with spaces support to point people at; null when the deployment names none. */
export function spacesServer(): { url: string; host: string } | null {
	const value = env.SPACES_PDS_URL?.trim();
	if (!value) return null;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' ? { url: url.href, host: url.host } : null;
	} catch {
		return null;
	}
}
