import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { error } from '@sveltejs/kit';
import '../../../../app.css';

const mocks = vi.hoisted(() => ({
	setGroupListed: vi.fn(),
	unlinkGroupSession: vi.fn(),
	finishGroupSetup: vi.fn(),
	turnOnMembersOnlyEvents: vi.fn()
}));
const member = vi.hoisted(() => ({ joinGroup: vi.fn(), cancelJoin: vi.fn(), leave: vi.fn() }));
const oauth = vi.hoisted(() => ({ requestPermissions: vi.fn() }));
// The page's writes and its event list's paging go through SvelteKit remote functions, which a
// browser test has no server for.
vi.mock('#lib/groups/group.remote.js', () => mocks);
vi.mock('#lib/groups/members.remote.js', () => member);
vi.mock('@svelte-atproto/oauth/client', () => oauth);
vi.mock('#lib/contrail/events.remote.js', () => ({ loadMoreEvents: vi.fn() }));

import { GUEST_SCOPE } from '#lib/private-events/scopes.js';
import GroupPage from './+page.svelte';

const GROUP = 'did:plc:group';

const EVENT = {
	uri: `at://${GROUP}/community.lexicon.calendar.event/e1`,
	rkey: 'e1',
	name: 'Night ride'
};

/** The page for someone who linked the group, as its load returns it; `can` is what the session's
 *  granted scope allows. */
function linkedPage(
	linked: { public: boolean; listed: boolean; reapprove?: boolean; unfinished?: boolean },
	can = { post: true, list: true, settings: true },
	events: (typeof EVENT)[] = []
) {
	return {
		pageTitle: 'Knitters',
		pageDescription: 'Events from Knitters.',
		group: {
			did: GROUP,
			handle: 'knit.example',
			name: 'Knitters',
			description: null,
			atHost: true,
			linked: {
				meta: { profile: { name: 'Knitters', description: null }, public: linked.public },
				listed: linked.listed,
				can,
				reapprove: linked.reapprove ?? false,
				unfinished: linked.unfinished ?? false
			},
			relink: false,
			hasLink: true
		},
		events,
		cursor: null,
		signedIn: true,
		notice: null
	};
}

const listButton = () => page.getByRole('button', { name: 'Add to the groups list' });
const shown = () => (document.body.textContent ?? '').replace(/\s+/g, ' ');

afterEach(() => vi.resetAllMocks());

describe("what a link's granted scope offers", () => {
	it('offers posting, editing and listing to a session that may', async () => {
		render(GroupPage, { data: linkedPage({ public: true, listed: false }) as never });
		await expect.element(page.getByRole('link', { name: 'Post an event' })).toBeVisible();
		await expect.element(listButton()).toBeVisible();
	});

	it("offers none of it to a member's session, and says why", async () => {
		render(GroupPage, {
			data: linkedPage(
				{ public: true, listed: false },
				{ post: false, list: false, settings: false },
				[EVENT]
			) as never
		});
		await expect
			.poll(shown)
			.toContain(
				'Your role in this group lets you see it here, but not post its events or list it.'
			);
		expect(page.getByRole('link', { name: 'Post an event' }).elements()).toHaveLength(0);
		expect(page.getByRole('link', { name: 'Edit' }).elements()).toHaveLength(0);
		expect(listButton().elements()).toHaveLength(0);
		expect(page.getByRole('button', { name: 'Unlink' }).elements()).toHaveLength(1);
		expect(page.getByRole('link', { name: 'Settings' }).elements()).toHaveLength(0);
	});

	it("offers the group's settings to a session that may change them", async () => {
		render(GroupPage, { data: linkedPage({ public: true, listed: true }) as never });
		await expect
			.element(page.getByRole('link', { name: 'Settings' }))
			.toHaveAttribute('href', `/groups/${encodeURIComponent(GROUP)}/settings`);
	});

	it('offers to approve again a link approved before atmo asked for all it does now', async () => {
		render(GroupPage, {
			data: linkedPage(
				{ public: true, listed: true, reapprove: true },
				{ post: true, list: true, settings: false }
			) as never
		});
		await expect.element(page.getByRole('button', { name: 'Approve again' })).toBeVisible();
		const form = page.getByRole('button', { name: 'Approve again' }).element().closest('form');
		expect(form?.getAttribute('action')).toBe('/oauth/group/link');
		expect(new FormData(form as HTMLFormElement).get('group')).toBe(GROUP);
	});

	it("finishes setting up a group made here when its link didn't", async () => {
		mocks.finishGroupSetup.mockResolvedValue({ ok: true });
		render(GroupPage, {
			data: linkedPage({ public: true, listed: true, unfinished: true }) as never
		});
		await page.getByRole('button', { name: 'Finish setting up' }).click();
		await expect.poll(() => mocks.finishGroupSetup).toHaveBeenCalledWith({ groupDid: GROUP });
	});
});

describe('listing a linked group', () => {
	it('offers no listing for a private group, and says why', async () => {
		render(GroupPage, { data: linkedPage({ public: false, listed: false }) as never });
		await expect.poll(shown).toContain('Only a public group can be on the groups list.');
		expect(listButton().elements()).toHaveLength(0);
	});

	it.each([
		[409, 'Only a public group can be listed, and this one is private.'],
		[403, 'Your role in this group no longer allows that.']
	] as const)('shows the reason the server gives with a %i', async (status, message) => {
		mocks.setGroupListed.mockImplementation(async () => error(status, message));
		render(GroupPage, { data: linkedPage({ public: true, listed: false }) as never });
		await listButton().click();
		await expect.element(page.getByRole('alert')).toHaveTextContent(message);
		expect(mocks.setGroupListed).toHaveBeenCalledWith({ groupDid: GROUP, listed: true });
	});

	it('keeps its own words for any other failure', async () => {
		mocks.setGroupListed.mockRejectedValue(new Error('the server said something else'));
		render(GroupPage, { data: linkedPage({ public: true, listed: false }) as never });
		await listButton().click();
		await expect
			.element(page.getByRole('alert'))
			.toHaveTextContent('That did not work. Try again, or link the group again.');
	});
});

/** The page for a signed-in person who has not linked the group, as its load returns it. */
function personPage(
	personal: { joinPolicy: string; public?: boolean } | null,
	isMember: boolean | null,
	access: 'ask' | 'refused' | null = null
) {
	return {
		pageTitle: 'Knitters',
		pageDescription: 'Events from Knitters.',
		group: {
			did: GROUP,
			handle: 'knit.example',
			name: 'Knitters',
			description: null,
			atHost: true,
			linked: null,
			relink: false,
			hasLink: false,
			personal: personal && {
				profile: { name: 'Knitters', description: null },
				public: personal.public ?? true,
				joinPolicy: personal.joinPolicy
			},
			member: isMember,
			askAccess: access !== null
		},
		events: [],
		cursor: null,
		signedIn: true,
		you: 'did:plc:alice',
		access,
		spacesServer:
			access === 'refused' ? { url: 'https://spaces.example/', host: 'spaces.example' } : null,
		notice: null
	};
}

describe("a person's own membership", () => {
	it('joins an open group at once', async () => {
		member.joinGroup.mockResolvedValue({ outcome: 'joined' });
		render(GroupPage, { data: personPage({ joinPolicy: 'open' }, false) as never });
		await page.getByRole('button', { name: 'Join' }).click();
		await expect.poll(() => member.joinGroup).toHaveBeenCalledWith({ groupDid: GROUP });
	});

	it('asks to join with a message, says the request waits, and cancels it', async () => {
		member.joinGroup.mockResolvedValue({ outcome: 'pending' });
		member.cancelJoin.mockResolvedValue({ ok: true });
		render(GroupPage, { data: personPage({ joinPolicy: 'approval' }, false) as never });
		await page.getByLabelText("A message for the group's admins (optional)").fill('I knit.');
		await page.getByRole('button', { name: 'Ask to join' }).click();
		await expect
			.element(page.getByText("Request sent. The group's admins will decide."))
			.toBeVisible();
		expect(member.joinGroup).toHaveBeenCalledWith({ groupDid: GROUP, message: 'I knit.' });
		await page.getByRole('button', { name: 'Cancel request' }).click();
		await expect.poll(() => member.cancelJoin).toHaveBeenCalledWith({ groupDid: GROUP });
		await expect.element(page.getByRole('button', { name: 'Ask to join' })).toBeVisible();
	});

	it('says a group takes members by invitation only, and offers no join', async () => {
		render(GroupPage, { data: personPage({ joinPolicy: 'invite' }, false) as never });
		await expect.poll(shown).toContain('This group takes members by invitation only.');
		expect(page.getByRole('button', { name: /join/i }).elements()).toHaveLength(0);
	});

	it("shows a private group's member they are one, and says why the last admin can't leave", async () => {
		const message =
			"You're the group's only admin, so you can't leave it. Make someone else an admin first.";
		member.leave.mockImplementation(async () => error(409, message));
		render(GroupPage, {
			data: personPage({ joinPolicy: 'approval', public: false }, true) as never
		});
		await expect.poll(shown).toContain('Private');
		await expect.poll(shown).toContain('Member');
		await page.getByRole('button', { name: 'Leave group' }).click();
		await expect.element(page.getByRole('alert')).toHaveTextContent(message);
	});

	it('links a member to the members page', async () => {
		const members = page.getByRole('link', { name: /^Members/ });
		render(GroupPage, { data: personPage({ joinPolicy: 'approval' }, true) as never });
		await expect.element(members).toBeVisible();
		expect(decodeURIComponent(members.query()?.getAttribute('href') ?? '')).toBe(
			`/groups/${GROUP}/members`
		);
	});

	it('does not link someone outside the group to the members page', async () => {
		render(GroupPage, { data: personPage({ joinPolicy: 'approval' }, false) as never });
		await expect.element(page.getByRole('button', { name: 'Ask to join' })).toBeVisible();
		expect(page.getByRole('link', { name: /^Members/ }).elements()).toHaveLength(0);
	});

	it('asks for the group permissions, and says why when their server said no', async () => {
		render(GroupPage, { data: personPage(null, null, 'ask') as never });
		await page.getByRole('button', { name: 'Allow joining groups' }).click();
		await expect
			.poll(() => oauth.requestPermissions.mock.calls[0]?.[0])
			.toEqual([
				'include:org.atgrp.authParticipate',
				'rpc:org.atgrp.internal.getActorGroups?aud=*',
				GUEST_SCOPE
			]);
	});

	it('points someone whose server has no spaces at the spaces server', async () => {
		render(GroupPage, { data: personPage(null, null, 'refused') as never });
		await expect.poll(shown).toContain('it takes spaces support');
		await expect
			.element(page.getByRole('link', { name: 'spaces.example' }))
			.toHaveAttribute('href', 'https://spaces.example/');
	});
});

describe('members-only events', () => {
	const ADMIN = {
		post: true,
		list: true,
		settings: true,
		turnOnMembersOnly: true,
		membersOnly: false
	};

	it('are turned on from the page, as the first of three steps', async () => {
		mocks.turnOnMembersOnlyEvents.mockResolvedValue({ ok: true });
		const data = { ...linkedPage({ public: true, listed: true }, ADMIN), calendar: 'missing' };
		render(GroupPage, { data: data as never });
		const setup = page.getByTestId('members-only-setup');
		await expect.element(setup).toBeVisible();
		expect(setup.element().querySelectorAll('li')).toHaveLength(3);
		await page.getByRole('button', { name: 'Turn on members-only events' }).click();
		await expect
			.poll(() => mocks.turnOnMembersOnlyEvents.mock.calls[0]?.[0])
			.toEqual({ groupDid: GROUP });
	});

	it('then ask the link to be approved once more, before anything is posted there', async () => {
		const data = { ...linkedPage({ public: true, listed: true }, ADMIN), calendar: 'ready' };
		render(GroupPage, { data: data as never });
		const approve = page.getByRole('button', { name: 'Approve once more' });
		await expect.element(approve).toBeVisible();
		const form = approve.element().closest('form');
		expect(form?.getAttribute('action')).toBe('/oauth/group/link');
		expect(form?.querySelector('input[name="group"]')?.getAttribute('value')).toBe(GROUP);
		expect(
			page.getByRole('button', { name: 'Turn on members-only events' }).elements()
		).toHaveLength(0);
	});

	it('are listed for those who may see them, marked members only, each to its own page', async () => {
		const posting = { ...ADMIN, membersOnly: true };
		const data = {
			...linkedPage({ public: true, listed: true }, posting),
			calendar: 'ready',
			membersOnly: {
				unread: false,
				events: [
					{
						name: 'Supper',
						rkey: '3ksupper',
						did: GROUP,
						startsAt: '2030-01-01T18:00:00Z',
						createdAt: '2029-01-01T00:00:00Z',
						uri: `at:space/${GROUP}/community.lexicon.calendar.collection/self/${GROUP}/community.lexicon.calendar.event/3ksupper`
					}
				]
			}
		};
		render(GroupPage, { data: data as never });
		const listed = page.getByTestId('members-only-event');
		await expect.element(listed).toBeVisible();
		expect(listed.element().textContent?.replace(/\s+/g, ' ')).toContain('Members only');
		const hrefs = [...listed.element().querySelectorAll('a')].map((a) =>
			decodeURIComponent(a.getAttribute('href') ?? '')
		);
		expect(hrefs).toContain(`/groups/${GROUP}/events/3ksupper`);
		expect(hrefs).toContain(`/groups/${GROUP}/events/3ksupper/edit`);
		expect(page.getByTestId('members-only-setup').elements()).toHaveLength(0);
	});
});
