import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { error } from '@sveltejs/kit';
import '../../../../app.css';

const mocks = vi.hoisted(() => ({
	unlinkGroupSession: vi.fn()
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
	},
	can = { post: true },
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
			hostSite: { url: 'https://host.example/', name: 'host.example' },
			atHost: true,
			linked: {
				meta: { profile: { name: 'Knitters', description: null }, public: linked.public },
				listed: linked.listed,
				can,
				reapprove: linked.reapprove ?? false
			},
			relink: false,
			hasLink: true
		},
		...events(upcoming),
		signedIn: true,
		notice: null
	};
}

const tools = () => page.getByRole('region', { name: 'Group tools' });
const shown = () => (document.body.textContent ?? '').replace(/\s+/g, ' ');

afterEach(() => vi.resetAllMocks());

describe("what a link's granted scope offers", () => {
	it('offers posting and editing to a session that may', async () => {
		render(GroupPage, {
			data: linkedPage({ public: true, listed: false }, undefined, [EVENT]) as never
		});
		await expect.element(page.getByRole('link', { name: 'Post an event' })).toBeVisible();
		await expect
			.element(page.getByRole('link', { name: 'Edit' }))
			.toHaveAttribute('href', `/groups/${encodeURIComponent(GROUP)}/events/e1/edit`);
		await expect.element(tools()).toBeVisible();
	});

	it("offers none of it to a member's session, and says why", async () => {
		render(GroupPage, {
			data: linkedPage({ public: true, listed: false }, { post: false }, [EVENT]) as never
		});
		await expect
			.poll(shown)
			.toContain('Your role in this group lets you see it here, but not post its events.');
		expect(page.getByRole('link', { name: 'Post an event' }).elements()).toHaveLength(0);
		expect(page.getByRole('link', { name: 'Edit' }).elements()).toHaveLength(0);
		expect(page.getByRole('button', { name: 'Unlink' }).elements()).toHaveLength(1);
		expect(tools().elements()).toHaveLength(0);
	});

	it('offers to approve again a link approved before atmo asked for all it does now', async () => {
		render(GroupPage, {
			data: linkedPage({ public: true, listed: true, reapprove: true }, { post: true }) as never
		});
		await expect.element(page.getByRole('button', { name: 'Approve again' })).toBeVisible();
		const form = page.getByRole('button', { name: 'Approve again' }).element().closest('form');
		expect(form?.getAttribute('action')).toBe('/oauth/group/link');
		expect(new FormData(form as HTMLFormElement).get('group')).toBe(GROUP);
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
			hostSite: { url: 'https://host.example/', name: 'host.example' },
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
		await expect
			.element(header().getByRole('link', { name: 'Group home: knit.example' }))
			.toBeVisible();
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

	it.each([null])(
		'offers nothing to confirm to a member who has, or one it could not tell of (%s)',
		async (confirmed) => {
			const data = personPage({ joinPolicy: 'approval' }, true);
			render(GroupPage, { data: { ...data, group: { ...data.group, confirmed } } as never });
			await expect.element(page.getByRole('button', { name: 'Leave group' })).toBeVisible();
			expect(page.getByRole('button', { name: 'Confirm membership' }).elements()).toHaveLength(0);
		}
	);

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

	it("links its website and its own address, each in a new tab that can't reach back", async () => {
		render(GroupPage, {
			data: withLinks('https://yarn.example/club', 'https://knit.example/') as never
		});
		for (const [name, href] of [
			[/^Website/, 'https://yarn.example/club'],
			[/^Group home/, 'https://knit.example/']
		] as const) {
			const link = page.getByRole('link', { name });
			await expect.element(link).toHaveAttribute('href', href);
			await expect.element(link).toHaveAttribute('target', '_blank');
			await expect.element(link).toHaveAttribute('rel', 'noopener noreferrer');
		}
		// Named by its address, so it can be told from the page's own links.
		await expect.element(page.getByRole('link', { name: 'Website: yarn.example' })).toBeVisible();
		await expect
			.element(page.getByRole('link', { name: 'Group home: knit.example' }))
			.toBeVisible();
	});

	it.each(['javascript:alert(1)', 'yarn.example', ''])(
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
		expect(page.getByRole('link', { name: /^Group home/ }).elements()).toHaveLength(0);
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

	it('hold, in one box, posting for a link that may', async () => {
		render(GroupPage, { data: linkedPage({ public: true, listed: true }) as never });
		await expect.element(tools()).toBeVisible();
		const box = tools().element();
		expect(box.querySelector('a[href$="/events/new"]')).not.toBeNull();
		expect(page.getByRole('region', { name: 'Group tools' }).elements()).toHaveLength(1);
	});
});
