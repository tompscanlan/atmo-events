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
const member = vi.hoisted(() => ({
	joinGroup: vi.fn(),
	cancelJoin: vi.fn(),
	leave: vi.fn(),
	confirmMember: vi.fn()
}));
const oauth = vi.hoisted(() => ({ requestPermissions: vi.fn() }));
// The page's writes and its event list's paging go through SvelteKit remote functions, which a
// browser test has no server for.
vi.mock('#lib/groups/group.remote.js', () => mocks);
vi.mock('#lib/groups/members.remote.js', () => member);
vi.mock('@svelte-atproto/oauth/client', () => oauth);
vi.mock('#lib/contrail/events.remote.js', () => ({ loadMoreEvents: vi.fn() }));
// The members page is not in this build; members-link.browser.spec.ts has it in.
vi.mock('#lib/groups/roster-switch.js', () => ({ ROSTER_IN_THIS_BUILD: false }));

import { GUEST_SCOPE } from '#lib/private-events/scopes.js';
import GroupPage from './+page.svelte';

const GROUP = 'did:plc:group';

const EVENT = {
	uri: `at://${GROUP}/community.lexicon.calendar.event/e1`,
	did: GROUP,
	rkey: 'e1',
	name: 'Night ride',
	startsAt: '2099-01-01T18:00:00Z',
	createdAt: '2029-01-01T00:00:00Z'
};

/** The events part of the page's data, as its load returns it. */
const events = (upcomingEvents: (typeof EVENT)[] = []) => ({
	ongoingEvents: [],
	ongoingTotal: 0,
	ongoingTotalIsFloor: false,
	upcomingEvents,
	hasMoreUpcoming: false,
	pastEvents: [],
	hasMorePast: false,
	eventsCreated: null
});

/** The page for someone who linked the group, as its load returns it; `can` is what the session's
 *  granted scope allows. */
function linkedPage(
	linked: {
		public: boolean;
		listed: boolean;
		reapprove?: boolean;
		unfinished?: { public: boolean; listed: boolean };
	},
	can = { post: true, list: true, settings: true },
	upcoming: (typeof EVENT)[] = []
) {
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
			atHost: true,
			linked: {
				meta: { profile: { name: 'Knitters', description: null }, public: linked.public },
				listed: linked.listed,
				can,
				reapprove: linked.reapprove ?? false,
				unfinished: linked.unfinished ?? null
			},
			relink: false,
			hasLink: true
		},
		...events(upcoming),
		signedIn: true,
		notice: null
	};
}

const listSwitch = () => page.getByRole('switch', { name: 'Show in public group lists' });
const tools = () => page.getByRole('region', { name: 'Group tools' });
const shown = () => (document.body.textContent ?? '').replace(/\s+/g, ' ');

afterEach(() => vi.resetAllMocks());

describe("what a link's granted scope offers", () => {
	it('offers posting, editing and listing to a session that may', async () => {
		render(GroupPage, {
			data: linkedPage({ public: true, listed: false }, undefined, [EVENT]) as never
		});
		await expect.element(page.getByRole('link', { name: 'Post an event' })).toBeVisible();
		await expect
			.element(page.getByRole('link', { name: 'Edit' }))
			.toHaveAttribute('href', `/groups/${encodeURIComponent(GROUP)}/events/e1/edit`);
		await expect.element(listSwitch()).toBeVisible();
		await expect.element(listSwitch()).not.toBeChecked();
		await expect.element(tools()).toBeVisible();
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
		expect(listSwitch().elements()).toHaveLength(0);
		expect(page.getByRole('button', { name: 'Unlink' }).elements()).toHaveLength(1);
		expect(page.getByRole('link', { name: 'Settings' }).elements()).toHaveLength(0);
		expect(tools().elements()).toHaveLength(0);
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
			data: linkedPage({
				public: false,
				listed: false,
				unfinished: { public: true, listed: false }
			}) as never
		});
		await expect
			.poll(shown)
			.toContain(
				"Setting up this group didn't finish: it isn't yet public and off the groups list"
			);
		await page.getByRole('button', { name: 'Finish setting up' }).click();
		await expect.poll(() => mocks.finishGroupSetup).toHaveBeenCalledWith({ groupDid: GROUP });
	});
});

describe('a link whose group host could not be reached', () => {
	it('shows the page as a visitor sees it, says why, and still unlinks', async () => {
		const data = linkedPage({ public: true, listed: true });
		render(GroupPage, {
			data: { ...data, group: { ...data.group, linked: null, unreachable: true } } as never
		});
		await expect.poll(shown).toContain("The group host couldn't be reached through your link");
		expect(page.getByRole('button', { name: 'Link this group' }).elements()).toHaveLength(0);
		expect(page.getByRole('button', { name: 'Unlink' }).elements()).toHaveLength(1);
		expect(page.getByRole('link', { name: 'Post an event' }).elements()).toHaveLength(0);
	});
});

describe("a group whose setup didn't finish", () => {
	it.each([
		['listed', { public: true, listed: true }],
		['members-only', { public: false, listed: false }]
	])('says no more than that of a %s group, which is as it was made', async (_kind, asked) => {
		render(GroupPage, {
			data: linkedPage({ public: asked.public, listed: asked.listed, unfinished: asked }) as never
		});
		await expect.poll(shown).toContain("Setting up this group here didn't finish.");
		expect(shown()).not.toContain('groups list, as you asked');
		expect(shown()).not.toContain('still on the groups list');
	});
});

describe('where members, requests to join and roles are managed', () => {
	const linkedWith = (
		joinPolicy: string | null,
		can = { post: true, list: true, settings: true },
		home: string | null = 'https://knit.example/'
	) => {
		const data = linkedPage({ public: true, listed: true }, can);
		const linked = { ...data.group.linked, meta: { ...data.group.linked.meta, joinPolicy } };
		return { ...data, group: { ...data.group, linked, home } };
	};
	const note = 'Members, requests to join and roles are managed at the group host';
	const there = () => page.getByRole('link', { name: "the group's page there" });

	it.each(['approval', 'open'])(
		"is said to an admin who linked a group (%s), with a link to the group's page there",
		async (joinPolicy) => {
			render(GroupPage, { data: linkedWith(joinPolicy) as never });
			await expect.poll(shown).toContain(note);
			await expect.element(there()).toHaveAttribute('href', 'https://knit.example/');
			await expect.element(there()).toHaveAttribute('target', '_blank');
			await expect.element(there()).toHaveAttribute('rel', 'noopener noreferrer');
			expect(tools().element().textContent).toContain('managed at the group host');
		}
	);

	it('is said without a link for a group with no home', async () => {
		render(GroupPage, { data: linkedWith('approval', undefined, null) as never });
		await expect.poll(shown).toContain(note);
		expect(there().elements()).toHaveLength(0);
	});

	it.each([
		[
			'a link that manages nothing',
			linkedWith('approval', { post: true, list: false, settings: false })
		],
		['a member who has not linked the group', personPage({ joinPolicy: 'approval' }, true)]
	])('is not said to %s', async (_who, data) => {
		render(GroupPage, { data: data as never });
		await expect.element(page.getByRole('heading', { level: 1 })).toBeVisible();
		expect(shown()).not.toContain(note);
	});
});

describe('listing a linked group', () => {
	it('shows a listed group switched on', async () => {
		render(GroupPage, { data: linkedPage({ public: true, listed: true }) as never });
		await expect.element(listSwitch()).toBeChecked();
		await expect.element(listSwitch()).toBeEnabled();
	});

	it('offers no listing for a private group, and says why', async () => {
		render(GroupPage, { data: linkedPage({ public: false, listed: false }) as never });
		await expect.poll(shown).toContain('Only a public group can be in them.');
		await expect.element(listSwitch()).toBeDisabled();
		await expect.element(listSwitch()).not.toBeChecked();
	});

	it.each([
		[409, 'Only a public group can be listed, and this one is private.'],
		[403, 'Your role in this group no longer allows that.']
	] as const)('shows the reason the server gives with a %i', async (status, message) => {
		mocks.setGroupListed.mockImplementation(async () => error(status, message));
		render(GroupPage, { data: linkedPage({ public: true, listed: false }) as never });
		await listSwitch().click();
		await expect.element(page.getByRole('alert')).toHaveTextContent(message);
		expect(mocks.setGroupListed).toHaveBeenCalledWith({ groupDid: GROUP, listed: true });
		// It did not take, so the switch shows the group as it is.
		await expect.element(listSwitch()).not.toBeChecked();
	});

	it('keeps its own words for any other failure', async () => {
		mocks.setGroupListed.mockRejectedValue(new Error('the server said something else'));
		render(GroupPage, { data: linkedPage({ public: true, listed: false }) as never });
		await listSwitch().click();
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
			website: null,
			home: 'https://knit.example/',
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
		...events(),
		signedIn: true,
		you: 'did:plc:alice',
		access,
		spacesServer:
			access === 'refused' ? { url: 'https://spaces.example/', host: 'spaces.example' } : null,
		notice: null
	};
}

describe("a person's own membership", () => {
	const header = () => page.getByRole('region', { name: 'Group', exact: true });

	it.each([
		['Join', personPage({ joinPolicy: 'open' }, false)],
		['Ask to join', personPage({ joinPolicy: 'approval' }, false)],
		['Leave group', personPage({ joinPolicy: 'approval' }, true)]
	])("is shown in the group's header: %s", async (name, data) => {
		render(GroupPage, { data: data as never });
		await expect.element(header().getByRole('button', { name, exact: true })).toBeVisible();
	});

	it("shows a visitor who is not signed in no join state, and the header's links", async () => {
		const data = personPage(null, null);
		render(GroupPage, {
			data: {
				...data,
				signedIn: false,
				you: null,
				group: { ...data.group, askAccess: false }
			} as never
		});
		await expect.element(header().getByRole('link', { name: 'Group home' })).toBeVisible();
		expect(page.getByRole('region', { name: 'Membership' }).elements()).toHaveLength(0);
		expect(page.getByRole('button', { name: /join/i }).elements()).toHaveLength(0);
	});

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

	it("offers no join, and says why, when it couldn't tell whether they are a member", async () => {
		render(GroupPage, { data: personPage({ joinPolicy: 'open' }, null) as never });
		await expect.poll(shown).toContain("Whether you're a member of this group couldn't be checked");
		expect(page.getByRole('button', { name: /join/i }).elements()).toHaveLength(0);
		expect(page.getByRole('button', { name: 'Leave group' }).elements()).toHaveLength(0);
	});

	it("carries a request sent, and a message typed, to no other group's page", async () => {
		member.joinGroup.mockResolvedValue({ outcome: 'pending' });
		const knitters = personPage({ joinPolicy: 'approval' }, false);
		const { rerender } = await render(GroupPage, { data: knitters as never });
		const box = page.getByLabelText("A message for the group's admins (optional)");
		await box.fill('I knit.');
		await page.getByRole('button', { name: 'Ask to join' }).click();
		await expect
			.element(page.getByText("Request sent. The group's admins will decide."))
			.toBeVisible();

		const other = { ...knitters, group: { ...knitters.group, did: 'did:plc:other', name: 'Purl' } };
		await rerender({ data: other as never });
		await expect.element(page.getByRole('button', { name: 'Ask to join' })).toBeVisible();
		expect(shown()).not.toContain('Request sent.');
		await expect.element(box).toHaveValue('');

		// Back on the first group's page, its request still shows until the page loads again.
		await rerender({ data: knitters as never });
		await expect
			.element(page.getByText("Request sent. The group's admins will decide."))
			.toBeVisible();
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

	it('offers a member who has not confirmed to confirm, and confirms when asked', async () => {
		member.confirmMember.mockResolvedValue({ ok: true });
		const data = personPage({ joinPolicy: 'approval' }, true);
		render(GroupPage, { data: { ...data, group: { ...data.group, confirmed: false } } as never });
		await page.getByRole('button', { name: 'Confirm membership' }).click();
		await expect.poll(() => member.confirmMember).toHaveBeenCalledWith({ groupDid: GROUP });
	});

	it.each([true, null])(
		'offers nothing to confirm to a member who has, or one it could not tell of (%s)',
		async (confirmed) => {
			const data = personPage({ joinPolicy: 'approval' }, true);
			render(GroupPage, { data: { ...data, group: { ...data.group, confirmed } } as never });
			await expect.element(page.getByRole('button', { name: 'Leave group' })).toBeVisible();
			expect(page.getByRole('button', { name: 'Confirm membership' }).elements()).toHaveLength(0);
		}
	);

	it('links no one to the members page in a build without it, not a member, nor an admin who may manage members', async () => {
		render(GroupPage, { data: personPage({ joinPolicy: 'approval' }, true) as never });
		await expect.element(page.getByRole('button', { name: 'Leave group' })).toBeVisible();
		expect(page.getByRole('link', { name: /^Members/ }).elements()).toHaveLength(0);
		expect(document.querySelector('a[href*="/members"]')).toBeNull();

		const can = { post: true, list: true, settings: true, admit: true, assign: true, remove: true };
		const data = linkedPage({ public: true, listed: true }, can);
		render(GroupPage, { data: { ...data, group: { ...data.group, member: true } } as never });
		await expect.element(page.getByRole('link', { name: 'Settings' })).toBeVisible();
		expect(page.getByRole('link', { name: /^Members/ }).elements()).toHaveLength(0);
		expect(document.querySelector('a[href*="/members"]')).toBeNull();
	});

	it('asks for the group permissions, and says why when their server said no', async () => {
		render(GroupPage, { data: personPage(null, null, 'ask') as never });
		await page.getByRole('button', { name: 'Allow joining groups' }).click();
		await expect
			.poll(() => oauth.requestPermissions.mock.calls[0]?.[0])
			.toEqual([
				'space:org.atgrp.meta?authority=*&skey=self&action=read',
				'space:org.atgrp.members?authority=*&skey=self&collection=org.atgrp.confirmation&action=read&action=create&action=delete',
				'rpc?lxm=org.atgrp.requestJoin&lxm=org.atgrp.cancelJoinRequest&lxm=org.atgrp.leaveGroup&aud=*',
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

	it('are turned on from the page, by a link that may turn them on', async () => {
		mocks.turnOnMembersOnlyEvents.mockResolvedValue({ ok: true });
		const data = { ...linkedPage({ public: true, listed: true }, ADMIN), calendar: 'missing' };
		render(GroupPage, { data: data as never });
		await expect.element(page.getByTestId('members-only-setup')).toBeVisible();
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

	it.each([
		['no-role', /Your role in this group doesn.t let you post to its calendar/],
		['unusable', /wasn.t set up for atmo to post members-only events to/]
	])(
		'say why atmo will not post there (%s), rather than to approve once more',
		async (calendar, words) => {
			const data = { ...linkedPage({ public: true, listed: true }, ADMIN), calendar };
			render(GroupPage, { data: data as never });
			await expect.element(page.getByText(words)).toBeVisible();
			expect(page.getByRole('button', { name: 'Approve once more' }).elements()).toHaveLength(0);
			expect(page.getByTestId('members-only-setup').elements()).toHaveLength(0);
		}
	);

	it('say where the list stopped, when it stopped at its limit', async () => {
		const posting = { ...ADMIN, membersOnly: true };
		const data = {
			...linkedPage({ public: true, listed: true }, posting),
			calendar: 'ready',
			membersOnly: { unread: false, stoppedAt: 500, events: [] }
		};
		render(GroupPage, { data: data as never });
		await expect
			.element(page.getByText(/atmo stopped reading this group.s calendar at 500 events/))
			.toBeVisible();
	});

	it('are listed for those who may see them, marked members only, each to its own page', async () => {
		const posting = { ...ADMIN, membersOnly: true };
		const data = {
			...linkedPage({ public: true, listed: true }, posting),
			calendar: 'ready',
			membersOnly: {
				unread: false,
				stoppedAt: null,
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

describe("the group's header", () => {
	const withLinks = (website: string | null, home: string | null) => {
		const data = personPage({ joinPolicy: 'open' }, false);
		return { ...data, group: { ...data.group, website, home } };
	};

	it('shows it as a group, by its name and address', async () => {
		render(GroupPage, { data: personPage({ joinPolicy: 'open' }, false) as never });
		await expect.element(page.getByRole('heading', { level: 1, name: 'Knitters' })).toBeVisible();
		await expect.element(page.getByText('Group', { exact: true })).toBeVisible();
		await expect.element(page.getByText('@knit.example')).toBeVisible();
	});

	it("links its website and its home at the group host, each in a new tab that can't reach back", async () => {
		render(GroupPage, {
			data: withLinks('https://yarn.example/club', 'https://knit.example/') as never
		});
		for (const [name, href] of [
			[/^Website/, 'https://yarn.example/club'],
			['Group home', 'https://knit.example/']
		] as const) {
			const link = page.getByRole('link', { name });
			await expect.element(link).toHaveAttribute('href', href);
			await expect.element(link).toHaveAttribute('target', '_blank');
			await expect.element(link).toHaveAttribute('rel', 'noopener noreferrer');
		}
		// Named by its address, so it can be told from the page's own links.
		await expect.element(page.getByRole('link', { name: 'Website: yarn.example' })).toBeVisible();
	});

	it.each(['javascript:alert(1)', 'data:text/html,hi', 'ftp://yarn.example/', 'yarn.example', ''])(
		'links no website that is not an http(s) URL (%s)',
		async (website) => {
			render(GroupPage, { data: withLinks(website, null) as never });
			await expect.element(page.getByRole('heading', { level: 1 })).toBeVisible();
			expect(page.getByRole('link', { name: /^Website/ }).elements()).toHaveLength(0);
			expect(document.querySelector('a[href^="javascript:"], a[href^="data:"]')).toBeNull();
		}
	);

	it('links no home for a group without one', async () => {
		render(GroupPage, { data: withLinks(null, null) as never });
		await expect.element(page.getByRole('heading', { level: 1 })).toBeVisible();
		expect(page.getByRole('link', { name: 'Group home' }).elements()).toHaveLength(0);
	});
});

describe('the group tools', () => {
	it('are shown to no visitor and no member who has not linked the group', async () => {
		render(GroupPage, { data: personPage({ joinPolicy: 'open' }, false) as never });
		await expect.element(page.getByRole('button', { name: 'Join' })).toBeVisible();
		expect(tools().elements()).toHaveLength(0);
		render(GroupPage, { data: personPage({ joinPolicy: 'open' }, true) as never });
		await expect.element(page.getByRole('button', { name: 'Leave group' })).toBeVisible();
		expect(tools().elements()).toHaveLength(0);
		expect(page.getByRole('link', { name: 'Post an event' }).elements()).toHaveLength(0);
	});

	it('hold, in one box, posting, the listing and the settings for a link that may', async () => {
		render(GroupPage, { data: linkedPage({ public: true, listed: true }) as never });
		await expect.element(tools()).toBeVisible();
		const box = tools().element();
		expect(box.querySelector('a[href$="/events/new"]')).not.toBeNull();
		expect(box.querySelector('a[href$="/settings"]')).not.toBeNull();
		expect(box.querySelector('[role="switch"]')).not.toBeNull();
		expect(page.getByRole('region', { name: 'Group tools' }).elements()).toHaveLength(1);
	});
});
