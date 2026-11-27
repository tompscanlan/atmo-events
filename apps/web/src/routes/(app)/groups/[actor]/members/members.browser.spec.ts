import { afterEach, describe, expect, it, vi } from 'vitest';
import { page, type Locator } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { error } from '@sveltejs/kit';
import '../../../../../app.css';

const mocks = vi.hoisted(() => ({
	approveRequest: vi.fn(),
	denyRequest: vi.fn(),
	changeRole: vi.fn(),
	removeFromGroup: vi.fn()
}));
// The acts are SvelteKit remote commands, which a browser test has no server for.
vi.mock('#lib/groups/members.remote.js', () => mocks);
vi.mock('@svelte-atproto/oauth/client', () => ({ requestPermissions: vi.fn() }));

import MembersPage from './+page.svelte';

const GROUP = 'did:plc:group';
const ALICE = 'did:plc:alice';
const BOB = 'did:plc:bob';
const CAROL = 'did:plc:carol';
const DAVE = 'did:plc:dave';

const entry = (did: string, handle: string | null, roles: string[], confirmed = true) => ({
	did,
	handle,
	roles,
	createdAt: 'x',
	confirmed
});

const rosterPage = (manage = { admit: true, assign: true, remove: true }, over = {}) => ({
	pageTitle: 'Members - Night Riders',
	group: { did: GROUP, name: 'Night Riders' },
	you: ALICE,
	state: 'roster',
	listed: [
		entry(ALICE, 'alice.example', ['member', 'admin']),
		entry(BOB, 'bob.example', ['member', 'rider'])
	],
	unconfirmed: manage.admit ? [entry(DAVE, null, ['member'], false)] : [],
	roles: [
		{ id: 'admin', name: 'Admin' },
		{ id: 'member', name: 'Member' },
		{ id: 'rider', name: 'Riders' }
	],
	yours: ['member', 'admin'],
	manage,
	next: null,
	paged: false,
	requests: manage.admit
		? [{ did: CAROL, handle: 'carol.example', message: 'I ride at night.', createdAt: 'x' }]
		: null,
	moreRequests: false,
	reapprove: false,
	...over
});

/** What a locator's element says, or nothing while it is not there. */
const text = (locator: Locator) => locator.query()?.textContent ?? '';

afterEach(() => vi.resetAllMocks());

describe("a group's members page", () => {
	it('lists the members with their roles, and gives a plain member no controls', async () => {
		render(MembersPage, {
			data: rosterPage({ admit: false, assign: false, remove: false }) as never
		});
		const members = page.getByRole('list', { name: 'Members' });
		await expect.poll(() => text(members)).toMatch(/@alice\.example/);
		await expect.poll(() => text(members)).toMatch(/Admin/);
		await expect.poll(() => text(members)).toMatch(/Riders/);
		expect(page.getByRole('button').elements()).toHaveLength(0);
		expect(page.getByText('Asking to join').elements()).toHaveLength(0);
		expect(page.getByText('Not confirmed yet').elements()).toHaveLength(0);
	});

	it('shows an admin the requests with their message, and admits or denies each', async () => {
		mocks.approveRequest.mockResolvedValue({ ok: true });
		mocks.denyRequest.mockResolvedValue({ ok: true });
		render(MembersPage, { data: rosterPage() as never });
		const requests = page.getByRole('list', { name: 'Asking to join' });
		await expect.poll(() => text(requests)).toMatch(/I ride at night\./);
		await requests.getByRole('button', { name: 'Approve' }).click();
		await expect
			.poll(() => mocks.approveRequest)
			.toHaveBeenCalledWith({
				groupDid: GROUP,
				did: CAROL
			});
		await requests.getByRole('button', { name: 'Deny' }).click();
		await expect
			.poll(() => mocks.denyRequest)
			.toHaveBeenCalledWith({ groupDid: GROUP, did: CAROL });
	});

	it('says older requests wait when the list stopped at its limit, and not otherwise', async () => {
		render(MembersPage, { data: rosterPage() as never });
		await expect
			.poll(() => text(page.getByRole('list', { name: 'Asking to join' })))
			.toMatch(/I ride/);
		expect(page.getByText(/Older requests are waiting too/).elements()).toHaveLength(0);
		render(MembersPage, { data: rosterPage(undefined, { moreRequests: true }) as never });
		await expect
			.element(page.getByText(/These are the newest 1\. Older requests are waiting too/))
			.toBeVisible();
	});

	it('makes a member an admin, an admin a member, and removes, never for themselves', async () => {
		mocks.changeRole.mockResolvedValue({ ok: true });
		mocks.removeFromGroup.mockResolvedValue({ ok: true });
		render(MembersPage, {
			data: rosterPage(undefined, {
				listed: [
					entry(ALICE, 'alice.example', ['member', 'admin']),
					entry(BOB, 'bob.example', ['member']),
					entry(CAROL, 'carol.example', ['member', 'admin'])
				]
			}) as never
		});
		const members = page.getByRole('list', { name: 'Members' });
		await members.getByRole('button', { name: 'Make admin' }).click();
		await expect
			.poll(() => mocks.changeRole)
			.toHaveBeenCalledWith({ groupDid: GROUP, did: BOB, admin: true });
		await members.getByRole('button', { name: 'Make member' }).click();
		await expect
			.poll(() => mocks.changeRole)
			.toHaveBeenLastCalledWith({ groupDid: GROUP, did: CAROL, admin: false });
		// Bob's and Carol's, not Alice's own.
		expect(members.getByRole('button', { name: 'Remove' }).elements()).toHaveLength(2);
		await members.getByRole('button', { name: 'Remove' }).first().click();
		await expect
			.poll(() => mocks.removeFromGroup)
			.toHaveBeenCalledWith({ groupDid: GROUP, did: BOB });
	});

	it('lists those not confirmed yet apart from the members, by DID when there is no handle', async () => {
		render(MembersPage, { data: rosterPage() as never });
		await expect
			.poll(() => text(page.getByRole('list', { name: 'Not confirmed yet' })))
			.toContain(DAVE);
		expect(text(page.getByRole('list', { name: 'Members' }))).not.toContain(DAVE);
	});

	it('shows the reason the server gives for a refusal', async () => {
		mocks.removeFromGroup.mockImplementation(async () =>
			error(409, 'That would leave the group with no admin. Make someone else an admin first.')
		);
		render(MembersPage, { data: rosterPage() as never });
		await page
			.getByRole('list', { name: 'Members' })
			.getByRole('button', { name: 'Remove' })
			.click();
		await expect
			.poll(() => text(page.getByRole('alert')))
			.toContain('That would leave the group with no admin.');
	});

	it('offers to approve the link again, for this group, when it predates the members page', async () => {
		render(MembersPage, {
			data: rosterPage({ admit: false, assign: false, remove: false }, { reapprove: true }) as never
		});
		const again = page.getByRole('button', { name: 'Approve again' });
		await expect.element(again).toBeVisible();
		const form = (again.element() as HTMLButtonElement).form!;
		expect(form.getAttribute('action')).toBe('/oauth/group/link');
		expect(form.method).toBe('post');
		expect(new FormData(form).get('group')).toBe(GROUP);
	});

	it('links to the next page of members, and back to the first from a later one', async () => {
		render(MembersPage, {
			data: rosterPage(undefined, { next: 'at:space/g/next', paged: true }) as never
		});
		const more = page.getByRole('link', { name: /^More members/ });
		await expect.element(more).toBeVisible();
		const href = new URL(more.element().getAttribute('href') ?? '', 'https://atmo.example');
		expect(decodeURIComponent(href.pathname)).toBe(`/groups/${GROUP}/members`);
		expect(href.searchParams.get('cursor')).toBe('at:space/g/next');
		const first = page.getByRole('link', { name: /First page/ });
		expect(decodeURIComponent(first.element().getAttribute('href') ?? '')).toBe(
			`/groups/${GROUP}/members`
		);
	});

	it('offers no other page when there is one page', async () => {
		render(MembersPage, { data: rosterPage() as never });
		await expect.element(page.getByRole('list', { name: 'Members' })).toBeVisible();
		expect(page.getByRole('link', { name: /More members|First page/ }).elements()).toHaveLength(0);
	});
});
