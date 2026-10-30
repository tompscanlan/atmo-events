import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CALENDAR_RSVP_SCOPE } from '../scopes';
import type { CallerSession } from './caller';

const mocks = vi.hoisted(() => ({ readMembersOnlyEvent: vi.fn() }));
vi.mock('./calendar-read', () => ({ readMembersOnlyEvent: mocks.readMembersOnlyEvent }));

import {
	deleteMembersOnlyRsvp,
	putMembersOnlyRsvp,
	readMembersOnlyRsvp,
	RsvpRefused
} from './member-rsvp';

const GROUP = 'did:plc:group';
const ALICE = 'did:plc:alice';
const CALENDAR = `at://${GROUP}/space/rsvp.atmo.group.calendar/self`;
const EVENT_URI = `${CALENDAR}/${GROUP}/community.lexicon.calendar.event/e1`;

type Answer = (pathname: string, init: RequestInit) => Response;

function member(
	answer: Answer = () => Response.json({}),
	scope = `atproto ${CALENDAR_RSVP_SCOPE}`
) {
	const handle = vi.fn(async (p: string, i: RequestInit) => answer(p, i));
	const caller: CallerSession = { did: ALICE, scope, handle };
	return { caller, calls: () => handle.mock.calls };
}

const body = (init: RequestInit) => JSON.parse(String(init.body));
const reason = (run: Promise<unknown>) =>
	run.then(
		() => null,
		(e) => (e instanceof RsvpRefused ? e.reason : e)
	);

beforeEach(() => {
	vi.resetAllMocks();
	vi.spyOn(console, 'error').mockImplementation(() => {});
	mocks.readMembersOnlyEvent.mockResolvedValue({ name: 'Trail day', cid: 'cid-1' });
});

describe('putMembersOnlyRsvp', () => {
	it("writes into the member's own repo in the calendar space, at the event's key, naming its version", async () => {
		const m = member();
		await putMembersOnlyRsvp(m.caller, GROUP, { rkey: 'e1', status: 'going', cid: 'cid-1' });
		const [pathname, init] = m.calls()[0];
		expect(pathname).toBe('/xrpc/com.atproto.space.putRecord');
		expect(body(init)).toMatchObject({
			space: CALENDAR,
			repo: ALICE,
			collection: 'community.lexicon.calendar.rsvp',
			rkey: 'e1',
			record: {
				$type: 'community.lexicon.calendar.rsvp',
				status: 'community.lexicon.calendar.rsvp#going',
				subject: { uri: EVENT_URI, cid: 'cid-1' }
			}
		});
		expect(mocks.readMembersOnlyEvent).toHaveBeenCalledWith(m.caller, GROUP, 'e1');
	});

	it('sends nothing without the grant', async () => {
		const m = member(undefined, 'atproto');
		expect(
			await reason(
				putMembersOnlyRsvp(m.caller, GROUP, { rkey: 'e1', status: 'going', cid: 'cid-1' })
			)
		).toBe('no-grant');
		expect(m.calls()).toEqual([]);
	});

	it('sends nothing for an event the member cannot see, or that changed since the page showed it', async () => {
		const m = member();
		mocks.readMembersOnlyEvent.mockResolvedValueOnce(null);
		expect(
			await reason(
				putMembersOnlyRsvp(m.caller, GROUP, { rkey: 'e1', status: 'going', cid: 'cid-1' })
			)
		).toBe('no-event');
		expect(
			await reason(
				putMembersOnlyRsvp(m.caller, GROUP, { rkey: 'e1', status: 'going', cid: 'cid-0' })
			)
		).toBe('changed');
		mocks.readMembersOnlyEvent.mockRejectedValueOnce(new Error('host down'));
		expect(
			await reason(
				putMembersOnlyRsvp(m.caller, GROUP, { rkey: 'e1', status: 'going', cid: 'cid-1' })
			)
		).toBe('unchecked');
		expect(m.calls()).toEqual([]);
	});

	it('throws when the PDS refuses, so nothing reads as saved', async () => {
		const m = member(() =>
			Response.json({ error: 'Forbidden', message: 'typed text' }, { status: 403 })
		);
		const thrown = await putMembersOnlyRsvp(m.caller, GROUP, {
			rkey: 'e1',
			status: 'going',
			cid: 'cid-1'
		}).catch((e) => e);
		expect(thrown).toBeInstanceOf(RsvpRefused);
		expect(thrown.reason).toBe('refused');
		expect(thrown.message).not.toContain('typed text');
	});
});

describe('deleteMembersOnlyRsvp', () => {
	it("deletes the member's own RSVP at the event's key", async () => {
		const m = member();
		await deleteMembersOnlyRsvp(m.caller, GROUP, 'e1');
		const [pathname, init] = m.calls()[0];
		expect(pathname).toBe('/xrpc/com.atproto.space.deleteRecord');
		expect(body(init)).toEqual({
			space: CALENDAR,
			repo: ALICE,
			collection: 'community.lexicon.calendar.rsvp',
			rkey: 'e1'
		});
	});

	it('throws when the PDS refuses', async () => {
		const m = member(() => Response.json({ error: 'InternalServerError' }, { status: 500 }));
		expect(await reason(deleteMembersOnlyRsvp(m.caller, GROUP, 'e1'))).toBe('refused');
	});
});

describe('readMembersOnlyRsvp', () => {
	const stored = (value: Record<string, unknown>) => () => Response.json({ value });

	it('reads the answer the member gave to this event', async () => {
		const m = member(
			stored({ status: 'community.lexicon.calendar.rsvp#interested', subject: { uri: EVENT_URI } })
		);
		expect(await readMembersOnlyRsvp(m.caller, GROUP, 'e1')).toBe('interested');
		expect(m.calls()[0][0]).toContain('repo=did%3Aplc%3Aalice');
	});

	it('is none for an RSVP naming another event, for no RSVP, and for a failed read', async () => {
		const other = member(
			stored({ status: 'community.lexicon.calendar.rsvp#going', subject: { uri: 'at://x' } })
		);
		expect(await readMembersOnlyRsvp(other.caller, GROUP, 'e1')).toBeNull();
		const none = member(() => Response.json({ error: 'RecordNotFound' }, { status: 400 }));
		expect(await readMembersOnlyRsvp(none.caller, GROUP, 'e1')).toBeNull();
		const down = member(() => Response.json({ error: 'InternalServerError' }, { status: 500 }));
		expect(await readMembersOnlyRsvp(down.caller, GROUP, 'e1')).toBeNull();
	});
});
