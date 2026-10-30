// Making a group: the host makes the account and its spaces during the creator's sign-in
// (`startGroupCreate`); this site then makes its calendar space and writes the settings as
// the group. Until all of it is done the group is not set up, and its creator is offered
// the rest: the marker and the settings wait in KV, since there is no table to hold either.
import { env } from 'cloudflare:workers';
import type { GroupWriter } from './context';
import type { ResolvedGroup } from './group';
import { createCalendarSpace } from './host';
import { applyGroupSettings, parseGroupSettings, type GroupSettings } from './settings';

const SETUP_PREFIX = 'group:setup:';

export interface PendingSetup {
	settings: GroupSettings;
	by: string;
}

/** A group whose setup has not finished, and who started it. */
export async function pendingSetup(groupDid: string): Promise<PendingSetup | null> {
	const kept = await env.OAUTH_SESSIONS?.get<Record<string, unknown>>(
		SETUP_PREFIX + groupDid,
		'json'
	);
	const settings = parseGroupSettings(kept?.settings);
	return settings && typeof kept?.by === 'string' ? { settings, by: kept.by } : null;
}

/** Makes the calendar space and writes the settings, keeping the marker until the last
 *  write lands. Throws on a stop; running it again finishes it. */
export async function finishSetup(
	writer: GroupWriter,
	group: Pick<ResolvedGroup, 'did' | 'handle'>,
	setup: PendingSetup
): Promise<void> {
	await env.OAUTH_SESSIONS.put(SETUP_PREFIX + group.did, JSON.stringify(setup));
	await createCalendarSpace(writer);
	await applyGroupSettings(writer, group, setup.settings);
	await env.OAUTH_SESSIONS.delete(SETUP_PREFIX + group.did);
}
