// The group page in a build without the settings page; group-page.browser.spec.ts shows it in one
// that has it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import '../../../../app.css';

vi.mock('#lib/groups/build.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/groups/build.js')>()),
	SETTINGS_IN_THIS_BUILD: false
}));
vi.mock('#lib/groups/group.remote.js', () => ({
	setGroupListed: vi.fn(),
	unlinkGroupSession: vi.fn(),
	finishGroupSetup: vi.fn(),
	turnOnMembersOnlyEvents: vi.fn()
}));
vi.mock('#lib/groups/members.remote.js', () => ({
	joinGroup: vi.fn(),
	cancelJoin: vi.fn(),
	leave: vi.fn(),
	confirmMember: vi.fn()
}));
vi.mock('@svelte-atproto/oauth/client', () => ({ requestPermissions: vi.fn() }));
vi.mock('#lib/contrail/events.remote.js', () => ({ loadMoreEvents: vi.fn() }));

import GroupPage from './+page.svelte';

const GROUP = 'did:plc:group';
const CAN = {
	post: true,
	list: true,
	settings: false,
	admit: false,
	assign: false,
	remove: false,
	turnOnMembersOnly: false,
	membersOnly: false
};

/** The page as its load returns it for someone who linked the group, with a link that may do
 *  `can`. */
function linkedPage(can: Partial<typeof CAN> = {}, home: string | null = 'https://knit.example/') {
	return {
		pageTitle: 'Knitters',
		pageDescription: 'Events from Knitters.',
		group: {
			did: GROUP,
			handle: 'knit.example',
			name: 'Knitters',
			description: null,
			website: null,
			home,
			atHost: true,
			linked: {
				meta: { profile: { name: 'Knitters', description: null }, public: true },
				listed: true,
				can: { ...CAN, ...can },
				reapprove: false,
				unfinished: null
			},
			relink: false,
			hasLink: true
		},
		ongoingEvents: [],
		upcomingEvents: [],
		pastEvents: [],
		eventsCreated: null,
		signedIn: true,
		notice: null
	};
}

const tools = () => page.getByRole('region', { name: 'Group tools' });

afterEach(() => vi.resetAllMocks());

describe('in a build without the settings page', () => {
	it('links nothing in the tools to it, even for a link that holds the settings', async () => {
		render(GroupPage, { data: linkedPage({ settings: true }) as never });
		await expect.element(tools()).toBeVisible();
		expect(tools().element().querySelector('a[href$="/settings"]')).toBeNull();
		expect(document.querySelector('a[href*="/settings"]')).toBeNull();
		// The rest of the tools stay.
		expect(tools().element().querySelector('a[href$="/events/new"]')).not.toBeNull();
		await expect
			.element(page.getByRole('switch', { name: 'Show in public group lists' }))
			.toBeChecked();
	});
});
