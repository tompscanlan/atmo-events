import { invalidateAll } from '$app/navigation';
import { resolve } from '$app/paths';
import {
	createInAppAdapter,
	type EditorAdapter,
	type EditorViewer
} from '#lib/components/editor/adapter.js';
import { RSVP_COLLECTION, RSVP_STATUSES, type RsvpStatus } from '#lib/private-events/ids.js';
import { spaceRecordUri } from '#lib/spaces/uri.js';
import { calendarSpaceUri } from './calendar';
import { cancelMembersOnlyRsvp, rsvpToMembersOnlyEvent } from './members-only.remote';

const isRefusal = (e: unknown) => (e as { status?: unknown } | null)?.status === 409;

function nothingElse(): never {
	throw new Error('a members-only event page writes only RSVPs');
}

/** For a members-only event's page, as private events' RSVP adapter is for theirs: the RSVP the view
 *  writes goes to the server, which puts it in the member's repo in the group's calendar space. A
 *  refusal throws, so the view never shows an RSVP that was not saved, and fetches the page again:
 *  an event that changed since it loaded refuses the version this page holds until the page has the
 *  new one. The page's own key for it is ignored, since the event's is the RSVP's. */
export function createMembersOnlyRsvpAdapter(
	groupDid: string,
	rkey: string,
	viewer: EditorViewer
): EditorAdapter {
	return {
		...createInAppAdapter({ viewer }),
		// The kit links the event to its public page unless told otherwise, which has none.
		urls: {
			event: (actor, eventRkey) =>
				resolve('/(app)/groups/[actor]/events/[rkey]', { actor, rkey: eventRkey }),
			edit: (actor, eventRkey) =>
				resolve('/(app)/groups/[actor]/events/[rkey]/edit', { actor, rkey: eventRkey })
		},
		linkedRecords: undefined,
		features: { delete: false, recurring: false, images: false, visibility: false },
		async putRecord({ collection, record }) {
			if (collection !== RSVP_COLLECTION) nothingElse();
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
			if (collection !== RSVP_COLLECTION) nothingElse();
			await cancelMembersOnlyRsvp({ groupDid, rkey });
		},
		createRecord: nothingElse,
		uploadBlob: nothingElse,
		onSaved() {},
		// Never the index: it would publish who is going.
		async notifyUpdate() {}
	};
}
