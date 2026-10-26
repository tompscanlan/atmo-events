// The members-only slice: who may cause the read, what it returns, and what a member is told
// when it cannot be made. The reader records every call, so "never touched" is asserted.
import { describe, expect, it } from 'vitest';
import {
	MEMBERS_ONLY_NO_ACCESS,
	MEMBERS_ONLY_UNREADABLE,
	membersOnlyEventForDisplay,
	membersOnlyEventForEditing,
	readMembersOnlyEvent,
	readMembersOnlyEvents
} from './calendar-read';
import type { GroupSpaceReader, GroupSpaceRecord } from './about-read';
import { NO_GRANTS } from '../scopes';
import type { CallerMembership, GroupEventRecord } from '../types';

const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const GROUP = { group_did: GROUP_DID };
// Written out, so a wrong space type, key or URI form in the code fails here.
const CALENDAR = `at://${GROUP_DID}/space/rsvp.atmo.group.calendar/self`;
const EVENT = 'community.lexicon.calendar.event';
const spaceForm = (collection: string, rkey: string) =>
	`${CALENDAR}/${GROUP_DID}/${collection}/${rkey}`;

const MEETING: GroupSpaceRecord = {
	uri: spaceForm(EVENT, '3lmeeting'),
	cid: 'bafymeeting',
	collection: EVENT,
	rkey: '3lmeeting',
	value: {
		$type: EVENT,
		name: 'Committee call',
		startsAt: '2026-11-02T18:00:00.000Z',
		createdAt: '2026-10-02T09:00:00.000Z',
		media: [{ role: 'thumbnail', content: { $type: 'blob', ref: { $link: 'bafyimage' } } }]
	}
};
const ACCESS: GroupSpaceRecord = {
	uri: spaceForm('group.opensocial.access', 'self'),
	cid: 'bafyaccess',
	collection: 'group.opensocial.access',
	rkey: 'self',
	value: { public: false, grants: [] }
};

const membership = (onRoster: boolean): CallerMembership => ({
	did: 'did:plc:viewer',
	role: onRoster ? 'member' : null,
	pendingRequestId: null,
	permissions: new Set(),
	grants: NO_GRANTS,
	onRoster
});
const MEMBER = membership(true);
const STRANGER = membership(false);

function reader(records: GroupSpaceRecord[], fail?: Error) {
	const calls: string[] = [];
	const r: GroupSpaceReader & { calls: string[] } = {
		calls,
		async get(q) {
			calls.push(`get ${q.space} ${q.collection} ${q.rkey}`);
			if (fail) throw fail;
			return records.find((x) => x.collection === q.collection && x.rkey === q.rkey) ?? null;
		},
		async list(q) {
			calls.push(`list ${q.space} ${q.collection}`);
			if (fail) throw fail;
			return records;
		}
	};
	return r;
}

const spaceNotFound = () =>
	Object.assign(new Error('com.atproto.space.listRecords failed: SpaceNotFound'), {
		error: 'SpaceNotFound'
	});

describe('readMembersOnlyEvents', () => {
	it('reads nothing for a caller off the roster', async () => {
		const r = reader([MEETING]);
		expect(await readMembersOnlyEvents(STRANGER, r, GROUP)).toBeNull();
		expect(r.calls).toEqual([]);
	});

	it("lists the calendar space's events, not its access record, each naming the space", async () => {
		const r = reader([ACCESS, MEETING]);
		const slice = await readMembersOnlyEvents(MEMBER, r, GROUP);
		expect(r.calls).toEqual([`list ${CALENDAR} ${EVENT}`]);
		expect(slice).toEqual({
			events: [
				{
					uri: MEETING.uri,
					cid: MEETING.cid,
					rkey: MEETING.rkey,
					value: MEETING.value,
					space: CALENDAR
				}
			],
			notice: null
		});
	});

	it('tells a member whose sign-in reads no spaces why they see none, and reads nothing', async () => {
		expect(await readMembersOnlyEvents(MEMBER, null, GROUP)).toEqual({
			events: [],
			notice: MEMBERS_ONLY_NO_ACCESS
		});
	});

	it('shows nothing and says nothing for a group with no calendar space; a notice for any other failure', async () => {
		expect(await readMembersOnlyEvents(MEMBER, reader([], spaceNotFound()), GROUP)).toEqual({
			events: [],
			notice: null
		});
		expect(await readMembersOnlyEvents(MEMBER, reader([], new Error('502')), GROUP)).toEqual({
			events: [],
			notice: MEMBERS_ONLY_UNREADABLE
		});
	});
});

describe('readMembersOnlyEvent', () => {
	it('answers a stranger hidden, before any read, for a real and a made-up key alike', async () => {
		const r = reader([MEETING]);
		expect(await readMembersOnlyEvent(STRANGER, r, GROUP, '3lmeeting')).toEqual({
			status: 'hidden'
		});
		expect(await readMembersOnlyEvent(STRANGER, r, GROUP, '3lmadeup')).toEqual({
			status: 'hidden'
		});
		expect(r.calls).toEqual([]);
	});

	it('finds the event at its space URI, whole', async () => {
		const read = await readMembersOnlyEvent(MEMBER, reader([MEETING]), GROUP, '3lmeeting');
		expect(read).toEqual({
			status: 'found',
			event: {
				uri: MEETING.uri,
				cid: 'bafymeeting',
				rkey: '3lmeeting',
				value: MEETING.value,
				space: CALENDAR
			}
		});
	});

	it('answers absent for a key the space does not hold, and asks nothing for a key no record can have', async () => {
		expect(await readMembersOnlyEvent(MEMBER, reader([MEETING]), GROUP, '3lother')).toEqual({
			status: 'absent'
		});
		const r = reader([MEETING]);
		expect(await readMembersOnlyEvent(MEMBER, r, GROUP, '../x')).toEqual({ status: 'absent' });
		expect(r.calls).toEqual([]);
	});
});

describe('the copies a page gets', () => {
	const event: GroupEventRecord = { ...MEETING, space: CALENDAR };

	it('shows no image, and leaves the event it was given alone', () => {
		expect(membersOnlyEventForDisplay(event).value).not.toHaveProperty('media');
		expect(event.value).toHaveProperty('media');
	});

	it('hands the editor the record whole, with no key naming the space', () => {
		const forEditor = membersOnlyEventForEditing(event, GROUP);
		expect(forEditor).toMatchObject({ name: 'Committee call', media: MEETING.value.media });
		expect(forEditor).toMatchObject({ did: GROUP_DID, rkey: '3lmeeting', uri: MEETING.uri });
		expect(forEditor).not.toHaveProperty('space');
		expect(membersOnlyEventForEditing({ ...event, value: { name: 'x' } }, GROUP)).toBeNull();
	});
});
