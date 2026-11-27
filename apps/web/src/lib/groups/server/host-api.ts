import { groupHostUrl } from './enabled';

/** The path of the page for making a group in bluesky-social/group-host's console, which that host
 *  serves at its own address. It is that host's own path: the spec names no such page. */
export const NEW_GROUP_PATH = '/new';

/** The group host's own page for making a group, from GROUP_HOST_URL alone, with no call to the
 *  host; null with groups off. */
export function newGroupUrl(): string | null {
	const url = groupHostUrl();
	return url ? new URL(NEW_GROUP_PATH, url.origin).href : null;
}
