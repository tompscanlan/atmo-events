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
	requests: manage.admit
		? [{ did: CAROL, handle: 'carol.example', message: 'I ride at night.', createdAt: 'x' }]
		: null,
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

	it('shows those not confirmed yet to an admin, by DID when there is no handle', async () => {
		render(MembersPage, { data: rosterPage() as never });
		await expect
			.poll(() => text(page.getByRole('list', { name: 'Not confirmed yet' })))
			.toContain(DAVE);
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

	it('offers to approve the link again when it predates the members page', async () => {
		render(MembersPage, {
			data: rosterPage({ admit: false, assign: false, remove: false }, { reapprove: true }) as never
		});
		await expect.element(page.getByRole('button', { name: 'Approve again' })).toBeVisible();
	});

	it('tells someone outside the group that only members see it', async () => {
		render(MembersPage, {
			data: {
				pageTitle: 'Members',
				group: { did: GROUP, name: 'Night Riders' },
				you: ALICE,
				state: 'hidden',
				message: 'Only members can see who is in this group.'
			} as never
		});
		await expect
			.element(page.getByText('Only members can see who is in this group.'))
			.toBeVisible();
	});
});
