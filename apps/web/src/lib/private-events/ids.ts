// A person's private event: one space per event, held on their own PDS, with the event's key as
// the space's key. Values only, so the OAuth config and the pages can import them.
import { spaceRecordUri, spaceUri } from '#lib/spaces/uri.js';

/** It is in every URI in the space, so a rename strands what was written under the old name, and
 *  it must resolve wherever a scope names it. For now this is atmo.rsvp's published type for
 *  development and testing, until a lasting name is published. */
export const PRIVATE_CALENDAR_TYPE = 'rsvp.atmo.dev.space';
export const EVENT_COLLECTION = 'community.lexicon.calendar.event';
export const RSVP_COLLECTION = 'community.lexicon.calendar.rsvp';

/** A person's invitation inbox: one space on their own PDS that anyone may write to and only they
 *  read, since a PDS lists a space for someone only after they write in it and tells nobody they
 *  were added. A host writes an invite into each guest's. The pattern is the opensocial.group
 *  proposal's invites space; its invite can't name an event, so these are atmo's own, with testing
 *  names like the calendar type's. */
export const INBOX_TYPE = 'rsvp.atmo.dev.inbox';
export const INBOX_KEY = 'self';
export const INVITE_COLLECTION = 'rsvp.atmo.dev.invite';

/** The lexicon's `status` token suffixes. */
export const RSVP_STATUSES = ['going', 'interested', 'notgoing'] as const;
export type RsvpStatus = (typeof RSVP_STATUSES)[number];

export function privateEventSpace(host: string, rkey: string): string {
	return spaceUri(host, PRIVATE_CALENDAR_TYPE, rkey);
}

export function inboxSpace(owner: string): string {
	return spaceUri(owner, INBOX_TYPE, INBOX_KEY);
}

/** The host's own record in the space: the URI an RSVP to the event names. */
export function privateEventUri(host: string, rkey: string): string {
	return spaceRecordUri(privateEventSpace(host, rkey), host, EVENT_COLLECTION, rkey);
}

/** An event's own page, by handle when there is one. */
export function privateEventPath(hostHandleOrDid: string, rkey: string): string {
	return `/p/${encodeURIComponent(hostHandleOrDid)}/private/${encodeURIComponent(rkey)}`;
}
