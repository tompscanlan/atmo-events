import { createInAppAdapter } from '#lib/components/editor/adapter.js';
import type { EditorAdapter, EditorViewer } from '@atmo-dev/events-ui';
import {
	calendarSpaceUri,
	GROUP_RSVP_COLLECTION,
	RSVP_STATUSES,
	spaceRecordUri,
	type RsvpStatus
} from './ids';
import { cancelMembersOnlyRsvp, rsvpToMembersOnlyEvent } from './member-rsvp.remote';

function nothingElse(): never {
	throw new Error('a members-only event page writes only RSVPs');
}

/** For a members-only event's page: the RSVP the view writes goes to the server, which puts
 *  it in the member's repo in the calendar space. A refusal throws, so the view never shows
 *  an RSVP that was not saved; the page's own key for it is ignored, since the event's is
 *  the RSVP's. */
export function createMembersOnlyRsvpAdapter(
	groupDid: string,
	rkey: string,
	viewer: EditorViewer
): EditorAdapter {
	return {
		...createInAppAdapter({ viewer }),
		features: { delete: false, recurring: false, images: false },
		async putRecord({ collection, record }) {
			if (collection !== GROUP_RSVP_COLLECTION) nothingElse();
			const status = String(record.status).split('#')[1] as RsvpStatus;
			if (!RSVP_STATUSES.includes(status)) throw new Error(`unknown RSVP ${record.status}`);
			const subject = record.subject as { cid?: unknown } | undefined;
			const cid = typeof subject?.cid === 'string' ? subject.cid : null;
			await rsvpToMembersOnlyEvent({ groupDid, rkey, status, cid });
			return {
				uri: spaceRecordUri(calendarSpaceUri(groupDid), viewer.did ?? '', collection, rkey)
			};
		},
		async deleteRecord({ collection }) {
			if (collection !== GROUP_RSVP_COLLECTION) nothingElse();
			await cancelMembersOnlyRsvp({ groupDid, rkey });
		},
		createRecord: nothingElse,
		uploadBlob: nothingElse,
		onSaved() {},
		// Never the index: it would publish who is going.
		async notifyUpdate() {}
	};
}
