// The edit page, rendered on the server with the shared editor stubbed, as on
// the new-event page (../../new/page.test.ts). The body is the page's own
// markup, and the adapter the editor would have saved with is called directly.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import type { EditorAdapter } from '$lib/components/editor/adapter';

const editor = vi.hoisted(() => ({ renders: [] as Array<Record<string, unknown>> }));
const remote = vi.hoisted(() => ({
	putGroupEvent: vi.fn(),
	removeGroupEvent: vi.fn(),
	putGroupEventImage: vi.fn()
}));
vi.mock('@atmo-dev/events-ui', () => ({
	EventEditor: (_renderer: unknown, props: Record<string, unknown>) => {
		editor.renders.push(props);
	}
}));
vi.mock('$lib/atproto/auth.svelte', () => ({ user: { isLoggedIn: true } }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));
vi.mock('$lib/atproto/methods', () => ({ getRecord: vi.fn(), resolveHandle: vi.fn() }));
vi.mock('$lib/components/LoginModal.svelte', () => ({
	atProtoLoginModalState: { show: vi.fn() }
}));
vi.mock('$lib/groups/group-events.remote', () => remote);

import Page from './+page.svelte';

const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const EVENT = 'community.lexicon.calendar.event';
// Written out, so a wrong type or key in the app's constant fails here.
const CALENDAR = `at://${GROUP_DID}/space/rsvp.atmo.group.calendar/self`;
const IMAGE = [
	{
		role: 'thumbnail',
		alt: 'The committee',
		content: { $type: 'blob', ref: { $link: 'bafkreithumb' }, mimeType: 'image/webp', size: 41250 }
	}
];

/** The page as the loader hands it a members-only event: the calendar space
 *  as its own field, and the event whole, image included. */
function membersOnlyData() {
	return {
		groupDid: GROUP_DID,
		groupName: 'Kona',
		handle: null,
		canDelete: true,
		rkey: '3lmeeting',
		eventData: {
			name: 'Committee call',
			startsAt: '2030-11-02T18:00:00.000Z',
			media: structuredClone(IMAGE),
			cid: 'bafymeeting',
			did: GROUP_DID,
			rkey: '3lmeeting',
			uri: `${CALENDAR}/${GROUP_DID}/${EVENT}/3lmeeting`
		},
		space: CALENDAR
	};
}

/** What a person reads: tags and Svelte's markers dropped, spaces collapsed. */
const textOf = (html: string) =>
	html
		.replace(/<[^>]*>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

afterEach(() => {
	editor.renders.length = 0;
	vi.resetAllMocks();
});

describe('/groups/[actor]/events/[rkey]/edit', () => {
	it('the edit page shows who can see the event and offers no way to change it', async () => {
		const eventData = { name: 'Sunrise paddle', startsAt: '2026-11-01T06:00:00.000Z' };
		const { body } = render(Page, {
			props: {
				data: {
					groupDid: GROUP_DID,
					groupName: 'Kona',
					handle: null,
					canDelete: true,
					rkey: '3lpaddle',
					eventData,
					space: null
				}
			} as never
		});
		const text = textOf(body);

		expect(text).toContain('Who can see this event: Everyone');
		expect(text).toContain("This can't be changed after the event is published.");
		// No control of the page's own (the editor's markup is stubbed out), and
		// no space named.
		expect(body).not.toMatch(/<(input|select|button|textarea)\b/);
		expect(body).not.toContain('/space/');
		expect(text).not.toMatch(/\bprivate\b/i);

		// The editor saves where the line says: the group's public repo.
		expect(editor.renders).toHaveLength(1);
		const { adapter } = editor.renders[0] as { adapter: EditorAdapter };
		expect(adapter.features.recurring).toBe(true);
		remote.putGroupEvent.mockResolvedValue({
			ok: true,
			uri: `at://${GROUP_DID}/${EVENT}/3lpaddle`
		});
		remote.removeGroupEvent.mockResolvedValue({ ok: true });
		await adapter.putRecord({ collection: EVENT, rkey: '3lpaddle', record: eventData });
		await adapter.deleteRecord({ collection: EVENT, rkey: '3lpaddle' });
		expect(remote.putGroupEvent.mock.calls).toEqual([
			[
				{
					groupDid: GROUP_DID,
					rkey: '3lpaddle',
					intent: 'update',
					placement: 'everyone',
					record: eventData
				}
			]
		]);
		expect(remote.removeGroupEvent.mock.calls).toEqual([
			[{ groupDid: GROUP_DID, rkey: '3lpaddle', placement: 'everyone' }]
		]);
	});

	it('the edit page saves a members-only event into the calendar space', async () => {
		const data = membersOnlyData();
		const { body } = render(Page, { props: { data } as never });
		const text = textOf(body);

		expect(text).toContain('Who can see this event: Members only');
		expect(text).toContain("This can't be changed after the event is published.");
		expect(text).not.toMatch(/\bprivate\b/i);
		expect(body).not.toMatch(/<(input|select|button|textarea)\b/);

		// The editor gets the event as loaded, and saves where the line says: the
		// calendar space, on every write and delete. No recurring copies, which
		// would cite the event by a URI in the group's repo.
		expect(editor.renders).toHaveLength(1);
		const { adapter, eventData } = editor.renders[0] as {
			adapter: EditorAdapter;
			eventData: unknown;
		};
		expect(eventData).toStrictEqual(data.eventData);
		expect(adapter.features.recurring).toBe(false);
		remote.putGroupEvent.mockResolvedValue({
			ok: true,
			uri: `${CALENDAR}/${GROUP_DID}/${EVENT}/3lmeeting`
		});
		remote.removeGroupEvent.mockResolvedValue({ ok: true });
		const record = { $type: EVENT, name: 'Committee call (moved)' };
		await adapter.putRecord({ collection: EVENT, rkey: '3lmeeting', record });
		await adapter.deleteRecord({ collection: EVENT, rkey: '3lmeeting' });
		expect(remote.putGroupEvent.mock.calls).toEqual([
			[{ groupDid: GROUP_DID, rkey: '3lmeeting', intent: 'update', placement: 'members', record }]
		]);
		expect(remote.removeGroupEvent.mock.calls).toEqual([
			[{ groupDid: GROUP_DID, rkey: '3lmeeting', placement: 'members' }]
		]);
	});

	// The editor's preview of an image the event already has comes from
	// cdn.bsky.app, which would hand a third party the group's DID and the
	// image's CID. A members-only event gets no preview until members can get
	// its image through atmo's own route; the save still keeps the image, since
	// the editor gets the event whole. (Spec: FR-119.)
	it('the edit page builds no image URL for a members-only event', () => {
		const data = membersOnlyData();
		const { body } = render(Page, { props: { data } as never });

		expect(editor.renders).toHaveLength(1);
		const props = editor.renders[0] as {
			eventData: { media: typeof IMAGE };
			storedImageUrl?: (blob: (typeof IMAGE)[number]['content']) => string | null;
		};
		expect(typeof props.storedImageUrl).toBe('function');
		expect(props.storedImageUrl!(IMAGE[0].content)).toBeNull();
		expect(props.eventData.media).toStrictEqual(IMAGE);
		expect(body).not.toContain('cdn.bsky.app');
		expect(body).not.toContain('bafkreithumb');

		// A public event's preview is the editor's own. (A server render
		// runs when its markup is read.)
		editor.renders.length = 0;
		const asPublic = render(Page, { props: { data: { ...data, space: null } } as never });
		expect(textOf(asPublic.body)).toContain('Who can see this event: Everyone');
		expect(editor.renders).toHaveLength(1);
		expect((editor.renders[0] as typeof props).storedImageUrl).toBeUndefined();
	});
});
