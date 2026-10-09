// The events tab, rendered on the server with the shared EventCard as it ships,
// so each card's link and lock are what a visitor's browser gets. Only the card
// is taken from the UI package: its index also pulls in plyr's CSS, which
// Node's ESM loader rejects.
import { describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';

vi.mock('@atmo-dev/events-ui', async () => ({
	EventCard: (await import('@atmo-dev/events-ui/EventCard.svelte')).default
}));

import Page from './+page.svelte';
import type { GroupEventRecord, GroupRow } from '$lib/groups/types';

const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const EVENT = 'community.lexicon.calendar.event';
// Written out, so a wrong type or key in the app's constant fails here.
const CALENDAR = `at://${GROUP_DID}/space/net.openmeet.space.calendar/self`;

// A public event and a members-only one that share a key, as the two slices
// allow: only the placement tells their links apart.
const PUBLIC_PADDLE: GroupEventRecord = {
	uri: `at://${GROUP_DID}/${EVENT}/3lshared`,
	cid: 'bafypaddle',
	rkey: '3lshared',
	value: { name: 'Sunrise paddle', startsAt: '2030-11-01T06:00:00.000Z' }
};
const MEMBERS_MEETING: GroupEventRecord = {
	uri: `${CALENDAR}/${GROUP_DID}/${EVENT}/3lshared`,
	cid: 'bafymeeting',
	rkey: '3lshared',
	value: { name: 'Committee call', startsAt: '2030-11-02T18:00:00.000Z' },
	space: CALENDAR
};

function renderTab({ canManageEvents }: { canManageEvents: boolean }) {
	return render(Page, {
		props: {
			data: {
				group: { group_did: GROUP_DID } as GroupRow,
				groupName: 'Kona',
				handle: null,
				events: [MEMBERS_MEETING, PUBLIC_PADDLE],
				canCreateEvent: false,
				canManageEvents
			}
		} as never
	});
}

/** Each card, as its link and its markup. A card is one anchor holding no other. */
function cardsIn(body: string): Array<{ href: string; html: string }> {
	return [...body.matchAll(/<a href="([^"]*)" class="group grid[\s\S]*?<\/a>/g)].map((m) => ({
		href: m[1],
		html: m[0]
	}));
}

/** The href of every Edit link, in page order. */
function editLinksIn(body: string): string[] {
	return [...body.matchAll(/<a href="([^"]*)"[^>]*>Edit<\/a>/g)].map((m) => m[1]);
}

describe('/groups/[actor]/events', () => {
	it('the events tab links a members-only card to its page, and its lock says members only', () => {
		const { body } = renderTab({ canManageEvents: false });
		const cards = cardsIn(body);

		expect(cards.map((card) => card.href)).toEqual([
			`/groups/${GROUP_DID}/events/3lshared`,
			`/p/${GROUP_DID}/e/3lshared`
		]);
		const [membersOnly, open] = cards;
		expect(membersOnly.html).toContain('Committee call');
		expect(membersOnly.html).toContain('aria-label="Members only"');
		expect(open.html).toContain('Sunrise paddle');
		expect(open.html).not.toContain('aria-label');
		// One lock, in the app's own words, and no link into contrail's own space
		// flow, which this calendar space is not.
		expect(body.match(/aria-label="Members only"/g)).toHaveLength(1);
		expect(body).not.toContain('Private event');
		expect(body).not.toContain('/s/');
	});

	it("the events tab's Edit link names the placement of a members-only event only", () => {
		const { body } = renderTab({ canManageEvents: true });

		// A public event's edit page reads it from the index; a members-only
		// event's link says where it is, since the two share a key.
		expect(editLinksIn(body)).toEqual([
			`/groups/${GROUP_DID}/events/3lshared/edit?placement=members`,
			`/groups/${GROUP_DID}/events/3lshared/edit`
		]);

		// Someone who may not manage events gets no Edit link at all.
		expect(editLinksIn(renderTab({ canManageEvents: false }).body)).toEqual([]);
	});
});
