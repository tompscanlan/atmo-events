// One members-only event in a group's calendar space, and the group's host as
// that event's own pages read it.
//
// The host is the in-memory reader of ./space-reader.ts: the about space holds
// the group's profile, the members space holds no records, so a caller's
// standing comes from the roster rows, and the calendar space holds the event.
// A page test serves it through ./reader-host.ts, so the session, the transport
// and the real reader stay in front of it.
//
// The calendar space's type and key, the event collection and the space-form
// record URI are written out here rather than taken from the app's constants,
// so a wrong one in the code under test fails.
import type { GroupSpaceRecord } from '../about-read';
import { spaceReader, type FakeSpaceReader, type SpaceRecordInput } from './space-reader';

export const EVENT_COLLECTION = 'community.lexicon.calendar.event';

export const PUBLIC_POLICY = 'com.atproto.simplespace.defs#publicPolicy';

/** The name the group's profile record gives it. */
export const PROFILE_NAME = 'Kona Paddlers';

export function calendarSpaceOf(groupDid: string): string {
	return `at://${groupDid}/space/rsvp.atmo.group.calendar/self`;
}

/** The meeting's address in the calendar space, in the space form a read
 *  returns. */
export function meetingUri(groupDid: string, rkey = '3lmeeting'): string {
	return `${calendarSpaceOf(groupDid)}/${groupDid}/${EVENT_COLLECTION}/${rkey}`;
}

/** The meeting's image as the event editor stores it: a blob in the group's
 *  repo, cited by its CID. */
export const MEETING_IMAGE = [
	{
		role: 'thumbnail',
		alt: 'The committee',
		content: { $type: 'blob', ref: { $link: 'bafkreithumb' }, mimeType: 'image/webp', size: 41250 },
		aspect_ratio: { width: 800, height: 800 }
	}
];

/** The meeting as stored, but for its image. */
export const MEETING_VALUE = {
	$type: EVENT_COLLECTION,
	name: 'Committee call',
	description: 'Agenda in the group chat.',
	startsAt: '2030-11-02T18:00:00.000Z',
	endsAt: '2030-11-02T19:00:00.000Z',
	createdAt: '2026-10-02T09:00:00.000Z',
	additionalData: { agendaUrl: 'https://example.com/agenda' }
};

/** The calendar space's one event, as stored: with its image. A fresh copy on
 *  each call, so a case can change it. */
export function storedMeeting(groupDid: string): GroupSpaceRecord {
	return {
		uri: meetingUri(groupDid),
		cid: 'bafymeeting',
		collection: EVENT_COLLECTION,
		rkey: '3lmeeting',
		value: { ...structuredClone(MEETING_VALUE), media: structuredClone(MEETING_IMAGE) }
	};
}

export interface EventHostOptions {
	/** What the calendar space holds, or the error every read of it fails with.
	 *  The stored meeting, by default. */
	calendar?: SpaceRecordInput[] | Error;
	/** The read policy the about space reports. Public, by default. */
	policy?: string;
	/** Hears each call's log line, as `spaceReader`'s option does. */
	onCall?: (line: string) => void;
}

/** The group's host for a members-only event's pages. The pages read one event
 *  by its key, so a listing of the calendar space, or a question about its
 *  policy, fails loudly. */
export function eventHost(groupDid: string, options: EventHostOptions = {}): FakeSpaceReader {
	const { calendar = [storedMeeting(groupDid)], policy = PUBLIC_POLICY, onCall } = options;
	const space = calendarSpaceOf(groupDid);
	const about = `at://${groupDid}/space/group.opensocial.meta/self`;
	return spaceReader(groupDid, {
		space,
		records: [
			{
				space: about,
				collection: 'group.opensocial.profile',
				rkey: 'self',
				cid: 'bafyprofile',
				value: { displayName: PROFILE_NAME }
			},
			...(calendar instanceof Error ? [] : calendar)
		],
		policies: { [about]: policy },
		onCall,
		fail: (call) => {
			if (call.space !== space) return undefined;
			if (call.method !== 'get') {
				return new Error(`the pages read one event by its key, never with ${call.method}`);
			}
			return calendar instanceof Error ? calendar : undefined;
		}
	});
}
