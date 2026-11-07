// With groups off, a group address shows the page any address this site never had shows.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import { env } from 'cloudflare:workers';

const { page } = vi.hoisted(() => ({
	page: { status: 404, error: null as { message: string } | null }
}));
vi.mock('$app/state', () => ({ page }));
vi.mock('./browse', () => ({ browseGroups: vi.fn() }));
vi.mock('./group', () => ({ resolveGroup: vi.fn(), isDeclared: vi.fn() }));
vi.mock('./sign-in', () => ({ groupSession: vi.fn(), hasGroupSession: vi.fn() }));

import ErrorPage from '../../../routes/+error.svelte';
import { load as listGroups } from '../../../routes/(app)/groups/+page.server';
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

const listRequest = {
	locals: { did: null },
	url: new URL('https://atmo.example/groups'),
	setHeaders: vi.fn()
} as unknown as Parameters<typeof listGroups>[0];

beforeEach(() => {
	Reflect.deleteProperty(env, 'GROUP_HOST_URL');
});

describe('with groups off', () => {
	it('shows the groups list and a group page as an unknown address', async () => {
		const expected = unknownAddress();
		expect(await shown(() => listGroups(listRequest))).toBe(expected);
		expect(await shown(() => groupView(GROUP, null))).toBe(expected);
		expect(await shown(() => groupView(GROUP, ALICE))).toBe(expected);
	});

	it('refuses writes and unlinking with the same 404', async () => {
		const expected = unknownAddress();
		expect(await shown(() => requireGroupWriter(GROUP, ALICE))).toBe(expected);
		expect(await shown(() => requireStoredLink(GROUP, ALICE))).toBe(expected);
	});
});
