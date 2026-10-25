import { describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';

vi.mock('@atmo-dev/events-ui', async () => ({
	EventCard: (await import('@atmo-dev/events-ui/EventCard.svelte')).default
}));
vi.mock('$lib/atproto/auth.svelte', () => ({ reauthorize: vi.fn() }));
vi.mock('$lib/groups/roster.remote', () => ({ signInForGroup: vi.fn() }));

import Page from './+page.svelte';
import type { GroupEventRecord } from '$lib/groups/types';

const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';

const PADDLE: GroupEventRecord = {
	uri: `at://${GROUP_DID}/community.lexicon.calendar.event/3lpaddle`,
	cid: 'bafypaddle',
	rkey: '3lpaddle',
	value: { name: 'Sunrise paddle', startsAt: '2030-11-01T06:00:00.000Z' }
};

function renderTab(canManageEvents: boolean) {
	return render(Page, {
		props: {
			data: {
				group: { group_did: GROUP_DID },
				groupName: 'Kona',
				handle: null,
				events: [PADDLE],
				canCreateEvent: false,
				canManageEvents
			}
		} as never
	}).body;
}

const cardLinks = (body: string) =>
	[...body.matchAll(/<a href="([^"]*)" class="group grid/g)].map((m) => m[1]);
const editLinks = (body: string) =>
	[...body.matchAll(/<a href="([^"]*)"[^>]*>Edit<\/a>/g)].map((m) => m[1]);

describe('/groups/[actor]/events', () => {
	it('links each card to the public event page, with no lock', () => {
		const body = renderTab(false);
		expect(cardLinks(body)).toEqual([`/p/${GROUP_DID}/e/3lpaddle`]);
		expect(body).not.toContain('aria-label="Members only"');
	});

	it('shows an Edit link only to someone who may manage events', () => {
		expect(editLinks(renderTab(true))).toEqual([`/groups/${GROUP_DID}/events/3lpaddle/edit`]);
		expect(editLinks(renderTab(false))).toEqual([]);
	});

	it('shows a hidden group only the sign-in notice', () => {
		const body = render(Page, {
			props: { data: { groupDid: GROUP_DID, signInOnly: true } } as never
		}).body;
		expect(cardLinks(body)).toEqual([]);
		expect(body).toContain('Sign in again');
	});
});
