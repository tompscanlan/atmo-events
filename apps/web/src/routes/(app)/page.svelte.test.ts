import { describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import type { FlatEventRecord } from '#lib/contrail.js';

const { user } = vi.hoisted(() => ({
	user: { isLoggedIn: true, did: 'did:plc:mememememememememememememe', profile: null }
}));
vi.mock('#lib/atproto/auth.svelte.js', () => ({ user, logout: vi.fn() }));

import HomePage from './+page.svelte';

const event = (uri: string, name: string): FlatEventRecord => ({
	uri,
	did: 'did:plc:host',
	rkey: uri.split('/').at(-1)!,
	name,
	startsAt: '2099-07-01T12:00:00Z',
	createdAt: '2026-06-01T00:00:00Z'
});
const DINNER = event(
	'at://did:plc:host/space/rsvp.atmo.dev.space/cal-3lsupper/did:plc:host/community.lexicon.calendar.event/3ldinner',
	'Dinner'
);
const PICNIC = event('at://did:plc:host/community.lexicon.calendar.event/3lpicnic', 'Picnic');

function markup(privateLinks: Record<string, { href: string; calendar: string | null }>) {
	return render(HomePage, {
		props: {
			data: {
				events: [],
				handles: {},
				myUpcoming: [DINNER, PICNIC],
				myPast: [],
				privateLinks,
				recentActivity: [],
				recentActivityIsPersonalized: false
			} as never
		}
	}).body;
}

/** The markup as text reads: no hydration markers, and runs of white space as one space. */
const shown = (html: string) => html.replace(/<!--.*?-->/g, '').replace(/\s+/g, ' ');

describe('Your events on the home page', () => {
	it('marks a private event with a lock line and links it to its own page', () => {
		const body = markup({
			[DINNER.uri]: {
				href: '/p/host.example.com/calendar/cal-3lsupper/3ldinner',
				calendar: 'Supper club'
			}
		});
		expect(body.match(/data-testid="your-private-event"/g)).toHaveLength(1);
		expect(body).toContain('href="/p/host.example.com/calendar/cal-3lsupper/3ldinner"');
		expect(shown(body)).toContain('Private event. Only the people on Supper club can see it.');
		expect(body).toContain('Picnic');
	});

	it('calls one of its own a private event', () => {
		const body = markup({
			[DINNER.uri]: { href: '/p/host.example.com/private/3ldinner', calendar: null }
		});
		expect(body).toContain('href="/p/host.example.com/private/3ldinner"');
		expect(body).toContain('Private event');
	});

	it('draws public events as before, with no lock', () => {
		const body = markup({});
		expect(body).not.toContain('your-private-event');
		expect(body).toContain('Dinner');
		expect(body).toContain('Picnic');
	});
});
