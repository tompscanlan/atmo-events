// The group page's link to the members page, in a build that has it; group-page.browser.spec.ts
// shows the page in one that does not.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import '../../../../app.css';

vi.mock('#lib/groups/build.js', () => ({ ROSTER_IN_THIS_BUILD: true }));
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
	settings: true,
	admit: true,
	assign: true,
	remove: true,
	turnOnMembersOnly: false,
	membersOnly: false
};

/** The page as its load returns it, for someone the host counts a member or not, with a link that
 *  may manage members or none. */
function groupPage(member: boolean | null, linked: boolean) {
	return {
		pageTitle: 'Knitters',
		pageDescription: 'Events from Knitters.',
		group: {
			did: GROUP,
			handle: 'knit.example',
			name: 'Knitters',
			description: null,
			website: null,
			home: null,
			atHost: true,
			linked: linked
				? {
						meta: { profile: { name: 'Knitters', description: null }, public: true },
						listed: true,
						can: CAN,
						reapprove: false,
						unfinished: null
					}
				: null,
			relink: false,
			hasLink: linked,
			personal: {
				profile: { name: 'Knitters', description: null },
				public: true,
				joinPolicy: 'approval'
			},
			member,
			askAccess: false
		},
		ongoingEvents: [],
		upcomingEvents: [],
		pastEvents: [],
		eventsCreated: null,
		signedIn: true,
		you: 'did:plc:alice',
		access: null,
		spacesServer: null,
		notice: null
	};
}

const membersLinks = () => page.getByRole('link', { name: /^Members/ }).elements();

afterEach(() => vi.resetAllMocks());

describe('in a build with the members page', () => {
	it('links a member to it', async () => {
		render(GroupPage, { data: groupPage(true, false) as never });
		await expect.element(page.getByRole('link', { name: /^Members/ })).toBeVisible();
		expect(decodeURIComponent(membersLinks()[0]?.getAttribute('href') ?? '')).toBe(
			`/groups/${GROUP}/members`
		);
	});

	it.each([
		[false, 0],
		[null, 0],
		[true, 1]
	])(
		'links an admin whose link may manage members only when the host counts them a member (%s)',
		async (member, links) => {
			render(GroupPage, { data: groupPage(member, true) as never });
			await expect.element(page.getByRole('link', { name: 'Settings' })).toBeVisible();
			expect(membersLinks()).toHaveLength(links);
		}
	);

	it('does not link someone outside the group', async () => {
		render(GroupPage, { data: groupPage(false, false) as never });
		await expect.element(page.getByRole('button', { name: 'Ask to join' })).toBeVisible();
		expect(membersLinks()).toHaveLength(0);
	});
});
