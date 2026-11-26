import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { error } from '@sveltejs/kit';
import '../../../../app.css';

const mocks = vi.hoisted(() => ({
	setGroupListed: vi.fn(),
	unlinkGroupSession: vi.fn(),
	finishGroupSetup: vi.fn()
}));
// The page's writes and its event list's paging go through SvelteKit remote functions, which a
// browser test has no server for.
vi.mock('#lib/groups/group.remote.js', () => mocks);
vi.mock('#lib/contrail/events.remote.js', () => ({ loadMoreEvents: vi.fn() }));

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
