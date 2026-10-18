// The sign-in notice, rendered on the server. The reason for the wait shows
// only when there is a wait (`from` set), found by its attribute, not its words.
import { describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';

vi.mock('$lib/atproto/auth.svelte', () => ({ reauthorize: vi.fn() }));
vi.mock('$lib/groups/roster.remote', () => ({ signInForGroup: vi.fn() }));

import GroupSignInNotice from './GroupSignInNotice.svelte';

const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';

function renderNotice(from: number | null) {
	return render(GroupSignInNotice, { props: { groupDid: GROUP_DID, from } }).body;
}

describe('GroupSignInNotice', () => {
	it('gives the reason for the wait when a new sign-in has to wait', () => {
		expect(renderNotice(Date.now() + 5 * 60_000)).toContain('data-sign-in-wait-reason');
	});

	it('gives no reason when a new sign-in can carry the group already', () => {
		expect(renderNotice(null)).not.toContain('data-sign-in-wait-reason');
	});
});
