// With groups off, no route matches a groups address, so SvelteKit answers it, for every method, as an
// address this site never had: the group pages and their form actions, and the group sign-in endpoints.
import { describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';

vi.mock('#lib/atproto/server/oauth.js', () => ({ getAuth: vi.fn() }));

// The server hooks hand the switch to the reroute hook.
import '../../hooks.server';
import { reroute } from '../../hooks';
import { NO_ROUTE } from './reroute';

const GROUP = 'did:plc:group';

/** Every groups address, with each method its route answers. Reroute reads only the address. */
const GROUP_ADDRESSES = [
	'/groups',
	'/groups/',
	`/groups/${GROUP}`,
	`/groups/${GROUP}/members`,
	`/groups/${GROUP}/settings`,
	`/groups/${GROUP}/events/new`,
	`/groups/${GROUP}/events/3kabc`,
	`/groups/${GROUP}/events/3kabc/edit`,
	'/groups/create',
	'/oauth/group/callback',
	'/oauth/group/client-metadata.json',
	'/oauth/group/link',
	'/%67roups/create'
];

const OTHER_ADDRESSES = [
	'/',
	'/events',
	'/groupsx',
	'/p/alice.example/groups',
	'/oauth/callback',
	'/oauth/groupx',
	'/oauth-client-metadata.json',
	'/groups/%zz'
];

const rerouted = (path: string) =>
	reroute({ url: new URL(`https://atmo.example${path}`), fetch: vi.fn() });

describe('with groups off', () => {
	it('matches no route for any groups address, whatever the method', () => {
		for (const path of GROUP_ADDRESSES) expect(rerouted(path), path).toBe(NO_ROUTE);
	});

	it('leaves every other address as it is', () => {
		for (const path of OTHER_ADDRESSES) expect(rerouted(path), path).toBeUndefined();
	});

	it('reroutes to a path that no route of this site matches', () => {
		// Only a parameter at the top level could take "(groups-off)" as its first segment.
		const routes = Object.keys(import.meta.glob('/src/routes/**/+{page.svelte,server.ts}'));
		const firstSegments = routes.map(
			(file) =>
				file
					.slice('/src/routes'.length)
					.split('/')
					.filter((segment) => segment && !/^\(.*\)$/.test(segment))[0]
		);
		expect(firstSegments).toContain('groups');
		for (const segment of firstSegments) expect(segment ?? '').not.toMatch(/^\[/);
		expect(NO_ROUTE.split('/')[1]).toMatch(/^\(.*\)$/);
	});
});

describe('with groups on', () => {
	it('reroutes nothing', () => {
		Object.assign(env, { GROUP_HOST_URL: 'https://host.example' });
		for (const path of [...GROUP_ADDRESSES, ...OTHER_ADDRESSES])
			expect(rerouted(path), path).toBeUndefined();
	});

	it('takes a blank group host for off', () => {
		Object.assign(env, { GROUP_HOST_URL: '  ' });
		expect(rerouted('/groups/create')).toBe(NO_ROUTE);
	});

	it('takes a group host that is not a URL for off', () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		Object.assign(env, { GROUP_HOST_URL: 'host.example' });
		for (const path of GROUP_ADDRESSES) expect(rerouted(path), path).toBe(NO_ROUTE);
	});
});
