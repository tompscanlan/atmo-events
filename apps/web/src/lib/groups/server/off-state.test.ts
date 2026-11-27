// With groups off, a group address shows the page any address this site never had shows.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import { env } from 'cloudflare:workers';

const { page } = vi.hoisted(() => ({
	page: { status: 404, error: null as { message: string } | null }
}));
vi.mock('$app/state', () => ({ page }));
vi.mock('$app/server', () => ({
	command: (_schema: unknown, handler: unknown) =>
		Object.assign(handler as object, { __: { type: 'command' } }),
	getRequestEvent: () => ({ locals: { did: 'did:plc:alice' } })
}));
vi.mock('./group', () => ({ resolveGroup: vi.fn(), isDeclared: vi.fn() }));
vi.mock('./sign-in', () => ({ groupSession: vi.fn(), hasGroupSession: vi.fn() }));

import ErrorPage from '../../../routes/+error.svelte';
import { deleteGroupEvent, putGroupEvent } from '../group.remote';
import { cancelMembersOnlyRsvp, rsvpToMembersOnlyEvent } from '../members-only.remote';
import { cancelJoin, confirmMember, joinGroup, leave } from '../members.remote';
import { groupView, requireGroupWriter, requireStoredLink } from './context';

const GROUP = 'did:plc:group';
const ALICE = 'did:plc:alice';

/** The error page for what `fails` threw. */
async function shown(fails: () => Promise<unknown>): Promise<string> {
	const thrown = (await fails().then(
		() => null,
		(e: unknown) => e
	)) as { status: number; body: { message: string } } | null;
	expect(thrown).toMatchObject({ status: 404 });
	page.status = thrown!.status;
	page.error = thrown!.body;
	return render(ErrorPage).body;
}

/** What SvelteKit shows for an address with no route. */
function unknownAddress(): string {
	page.status = 404;
	page.error = { message: 'Not Found' };
	return render(ErrorPage).body;
}

beforeEach(() => {
	Reflect.deleteProperty(env, 'GROUP_HOST_URL');
});

describe('with groups off', () => {
	// The pages' own loads and the form action: routes/(app)/groups/off.test.ts.
	it('shows a group, to a visitor or a signed-in person, as an unknown address', async () => {
		const expected = unknownAddress();
		expect(await shown(() => groupView(GROUP, null))).toBe(expected);
		expect(await shown(() => groupView(GROUP, ALICE))).toBe(expected);
	});

	it('refuses writes and unlinking with the same 404', async () => {
		const expected = unknownAddress();
		expect(await shown(() => requireGroupWriter(GROUP, ALICE))).toBe(expected);
		expect(await shown(() => requireStoredLink(GROUP, ALICE))).toBe(expected);
	});

	it("refuses a person's join, cancel, leave and confirming with the same 404", async () => {
		const expected = unknownAddress();
		expect(await shown(() => confirmMember({ groupDid: GROUP }))).toBe(expected);
		expect(await shown(() => joinGroup({ groupDid: GROUP, message: 'hi' }))).toBe(expected);
		expect(await shown(() => cancelJoin({ groupDid: GROUP }))).toBe(expected);
		expect(await shown(() => leave({ groupDid: GROUP }))).toBe(expected);
	});

	it('refuses posting, deleting and RSVPing to members-only events with the same 404', async () => {
		const expected = unknownAddress();
		const members = { groupDid: GROUP, rkey: 'r', placement: 'members' as const };
		expect(await shown(() => putGroupEvent({ ...members, record: {} }))).toBe(expected);
		expect(await shown(() => deleteGroupEvent(members))).toBe(expected);
		expect(
			await shown(() =>
				rsvpToMembersOnlyEvent({ groupDid: GROUP, rkey: 'r', status: 'going', cid: null })
			)
		).toBe(expected);
		expect(await shown(() => cancelMembersOnlyRsvp({ groupDid: GROUP, rkey: 'r' }))).toBe(expected);
	});
});
