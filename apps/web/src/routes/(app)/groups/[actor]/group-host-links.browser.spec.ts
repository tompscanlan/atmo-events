// The group page, which links to the group host's own site for what changes there.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import '../../../../app.css';

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
	turnOnMembersOnly: false,
	membersOnly: false
};

/** The page as its load returns it for someone who linked the group, with a link that may do
 *  `can`. */
const HOST_SITE = { url: 'https://host.example/', name: 'host.example' };

function linkedPage(can: Partial<typeof CAN> = {}, hostSite: typeof HOST_SITE | null = HOST_SITE) {
	return {
		pageTitle: 'Knitters',
		pageDescription: 'Events from Knitters.',
		group: {
			did: GROUP,
			handle: 'knit.example',
			name: 'Knitters',
			description: null,
			website: null,
			home: 'https://knit.example/',
			hostSite,
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
const atHost = () => page.getByRole('link', { name: 'Group host: host.example' });
const shown = () => (document.body.textContent ?? '').replace(/\s+/g, ' ');
const SAID =
	"The group's name, description and who may join are changed at its group host, host.example ↗, as are its members, requests to join and roles.";
const SAID_UNLINKED =
	"The group's name, description and who may join are changed at its group host, as are its members, requests to join and roles.";

afterEach(() => vi.resetAllMocks());

describe("the group host's own site", () => {
	it.each([['a link that may only post', { list: false }]])(
		"links %s to its group host's own site, in a new tab, and says what changes there",
		async (_who, can) => {
			render(GroupPage, { data: linkedPage(can) as never });
			await expect.element(atHost()).toHaveAttribute('href', 'https://host.example/');
			await expect.element(atHost()).toHaveAttribute('target', '_blank');
			await expect.element(atHost()).toHaveAttribute('rel', 'noopener noreferrer');
			expect(tools().element().contains(atHost().element())).toBe(true);
			expect(tools().element().textContent?.replace(/\s+/g, ' ')).toContain(SAID);
			// The sentence links the same site, and nothing in the tools goes to the group's own
			// address, which may be any website.
			const said = tools().getByRole('link', { name: 'host.example' });
			await expect.element(said).toHaveAttribute('href', 'https://host.example/');
			expect(tools().element().querySelector('a[href="https://knit.example/"]')).toBeNull();
		}
	);

	it('still says what changes at the group host for one whose host has no site to link, with nothing to link', async () => {
		render(GroupPage, { data: linkedPage({}, null) as never });
		await expect.element(tools()).toBeVisible();
		expect(atHost().elements()).toHaveLength(0);
		expect(shown()).toContain(SAID_UNLINKED);
	});

	it('says nothing of it to someone who has not linked the group', async () => {
		const data = linkedPage();
		render(GroupPage, {
			data: { ...data, group: { ...data.group, linked: null, hasLink: false } } as never
		});
		await expect.element(page.getByRole('heading', { level: 1 })).toBeVisible();
		expect(atHost().elements()).toHaveLength(0);
		expect(shown()).not.toContain(SAID);
	});
});
