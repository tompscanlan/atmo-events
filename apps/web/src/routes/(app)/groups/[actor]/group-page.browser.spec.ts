import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import '../../../../app.css';

const mocks = vi.hoisted(() => ({
	unlinkGroupSession: vi.fn()
}));
// The page's writes and its event list's paging go through SvelteKit remote functions, which a
// browser test has no server for.
vi.mock('#lib/groups/group.remote.js', () => mocks);
vi.mock('#lib/contrail/events.remote.js', () => ({ loadMoreEvents: vi.fn() }));

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
function personPage() {
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
			hasLink: false
		},
		...events(),
		signedIn: true,
		notice: null
	};
}

describe("the group's header", () => {
	const withLinks = (website: string | null, home: string | null) => {
		const data = personPage();
		return { ...data, group: { ...data.group, website, home } };
	};

	it('shows it as a group, by its name and address', async () => {
		render(GroupPage, { data: personPage() as never });
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
	it('are shown to no one who has not linked the group', async () => {
		render(GroupPage, { data: personPage() as never });
		await expect.element(page.getByRole('heading', { level: 1 })).toBeVisible();
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
