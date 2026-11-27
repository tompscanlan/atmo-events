// With groups off, no route matches a groups address, so SvelteKit answers it, for every method, as an
// address this site never had: the group pages and their form actions, and the group sign-in endpoints.
import { describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';

vi.mock('#lib/atproto/server/oauth.js', () => ({ getAuth: vi.fn() }));
/** Which parts of groups are in the build; each test says. */
const build = vi.hoisted(() => ({ create: false, settings: false }));
vi.mock('./build', () => ({
	get CREATE_IN_THIS_BUILD() {
		return build.create;
	},
	get SETTINGS_IN_THIS_BUILD() {
		return build.settings;
	}
}));
type Part = keyof typeof build;
const PARTS = Object.keys(build) as Part[];
/** Every part in the build but `without`; every part, with none named. */
function inBuild(without?: Part) {
	for (const part of PARTS) build[part] = part !== without;
}
const noneInBuild = () => PARTS.forEach((part) => (build[part] = false));

// The server hooks hand the switch to the reroute hook.
import '../../hooks.server';
import { reroute } from '../../hooks';
import { NO_ROUTE } from './reroute';

const GROUP = 'did:plc:group';

/** Every address of the settings page. */
const SETTINGS_ADDRESSES = [
	`/groups/${GROUP}/settings`,
	`/groups/${GROUP}/settings/`,
	'/groups/knit.example/settings',
	`/groups/${GROUP}/%73ettings`
];

/** Every address of the create page. */
const CREATE_ADDRESSES = [
	'/groups/create',
	'/groups/create/',
	'/%67roups/create',
	'/groups/%63reate'
];

/** Every groups address, with each method its route answers. Reroute reads only the address. */
const GROUP_ADDRESSES = [
	'/groups',
	'/groups/',
	`/groups/${GROUP}`,
	...SETTINGS_ADDRESSES,
	`/groups/${GROUP}/events/new`,
	`/groups/${GROUP}/events/3kabc`,
	`/groups/${GROUP}/events/3kabc/edit`,
	...CREATE_ADDRESSES,
	'/oauth/group/callback',
	'/oauth/group/client-metadata.json',
	'/oauth/group/link'
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

/** Group addresses beside the create page's. */
const NOT_CREATE = [
	'/groups',
	'/groups/createx',
	`/groups/${GROUP}/create`,
	'/groups/knit.example',
	`/groups/${GROUP}/members`
];

/** Group addresses beside the settings page's. */
const NOT_SETTINGS = [
	`/groups/${GROUP}`,
	`/groups/${GROUP}/settingsx`,
	`/groups/${GROUP}/events/settings`,
	'/groups/settings',
	`/groups/${GROUP}/members`
];

/** Each part's addresses, and those beside them that are not its own. */
const ADDRESSES: Record<Part, { own: string[]; beside: string[] }> = {
	create: { own: CREATE_ADDRESSES, beside: NOT_CREATE },
	settings: { own: SETTINGS_ADDRESSES, beside: NOT_SETTINGS }
};

const rerouted = (path: string) =>
	reroute({ url: new URL(`https://atmo.example${path}`), fetch: vi.fn() });

describe('with groups off', () => {
	it('matches no route for any groups address', () => {
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

describe('with groups off, in a build with every part', () => {
	it('matches no route for any groups address', () => {
		inBuild();
		for (const path of GROUP_ADDRESSES) expect(rerouted(path), path).toBe(NO_ROUTE);
		noneInBuild();
	});
});

describe('with groups on', () => {
	const besides = PARTS.flatMap((part) => ADDRESSES[part].beside);

	it('reroutes nothing in a build with every part', () => {
		inBuild();
		Object.assign(env, { GROUP_HOST_URL: 'https://host.example' });
		for (const path of [...GROUP_ADDRESSES, ...OTHER_ADDRESSES, ...besides])
			expect(rerouted(path), path).toBeUndefined();
		noneInBuild();
	});

	it.each(PARTS)(
		"matches no route for the %s part's addresses alone in a build without it",
		(part) => {
			inBuild(part);
			Object.assign(env, { GROUP_HOST_URL: 'https://host.example' });
			const { own, beside } = ADDRESSES[part];
			for (const path of own) expect(rerouted(path), path).toBe(NO_ROUTE);
			const others = GROUP_ADDRESSES.filter((path) => !own.includes(path));
			for (const path of [...others, ...OTHER_ADDRESSES, ...beside])
				expect(rerouted(path), path).toBeUndefined();
			noneInBuild();
		}
	);

	it('matches no route for the addresses of every part left out, and only those', () => {
		noneInBuild();
		Object.assign(env, { GROUP_HOST_URL: 'https://host.example' });
		const own = PARTS.flatMap((part) => ADDRESSES[part].own);
		for (const path of own) expect(rerouted(path), path).toBe(NO_ROUTE);
		const others = GROUP_ADDRESSES.filter((path) => !own.includes(path));
		for (const path of [...others, ...OTHER_ADDRESSES])
			expect(rerouted(path), path).toBeUndefined();
	});
});
