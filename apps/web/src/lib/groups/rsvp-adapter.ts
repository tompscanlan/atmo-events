import { invalidateAll } from '$app/navigation';
import {
	createInAppAdapter,
	type EditorAdapter,
	type EditorViewer
} from '#lib/components/editor/adapter.js';
import {
	calendarSpaceUri,
	GROUP_RSVP_COLLECTION,
	RSVP_STATUSES,
	spaceRecordUri,
	type RsvpStatus
} from './ids';
import { cancelMembersOnlyRsvp, rsvpToMembersOnlyEvent } from './member-rsvp.remote';

const isRefusal = (e: unknown) => (e as { status?: unknown } | null)?.status === 409;

function nothingElse(): never {
	throw new Error('a members-only event page writes only RSVPs');
}

/** For a members-only event's page: the RSVP the view writes goes to the server, which puts
 *  it in the member's repo in the calendar space. A refusal throws, so the view never shows
 *  an RSVP that was not saved, and fetches the page again: an event that changed since it
 *  loaded refuses the version this page holds until the page has the new one. The page's own
 *  key for it is ignored, since the event's is the RSVP's. */
export function createMembersOnlyRsvpAdapter(
	groupDid: string,
	rkey: string,
	viewer: EditorViewer
): EditorAdapter {
	return {
		...createInAppAdapter({ viewer }),
		linkedRecords: undefined,
		features: { delete: false, recurring: false, images: false, visibility: false },
		async putRecord({ collection, record }) {
			if (collection !== GROUP_RSVP_COLLECTION) nothingElse();
			const status = String(record.status).split('#')[1] as RsvpStatus;
			if (!RSVP_STATUSES.includes(status)) throw new Error(`unknown RSVP ${record.status}`);
			const subject = record.subject as { cid?: unknown } | undefined;
			const cid = typeof subject?.cid === 'string' ? subject.cid : null;
			await rsvpToMembersOnlyEvent({ groupDid, rkey, status, cid }).catch(async (e) => {
				if (isRefusal(e)) await invalidateAll();
				throw e;
			});
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
