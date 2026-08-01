// RSVP transform: a `community.lexicon.calendar.rsvp` record -> the OpenMeet
// platform's existing `/api/integration/rsvps` intake call.
//
// Ported from bsky-event-processor's `RsvpProcessorService`
// (src/processor/rsvp-processor.service.ts @ 20d5c74), same rules as its event
// sibling: production-proven semantics preserved verbatim, NestJS/axios/metrics
// stripped, request returned as data rather than issued.
import { RSVP_COLLECTION, RSVP_STATUSES, type IntakeRequest, type SinkRecordEvent } from './types';
import type { TransformResult } from './event-transform';

const skip = (reason: string): TransformResult => ({ kind: 'skip', reason });

/** Pull the event reference out of an RSVP's `subject`.
 *
 *  Two shapes in the wild: the lexicon's StrongRef (`{ uri, cid }`) and a bare
 *  URI string from older clients. Both are accepted; only the StrongRef can
 *  supply a cid. */
function readSubject(subject: unknown): { uri: string; cid?: string } | { error: string } {
	if (typeof subject === 'string') return { uri: subject };
	if (typeof subject === 'object' && subject !== null) {
		const s = subject as { uri?: string; cid?: string };
		if (!s.uri) return { error: 'subject object missing uri field' };
		return { uri: s.uri, cid: s.cid };
	}
	return { error: `invalid subject format: ${typeof subject}` };
}

/** Strip the lexicon NSID prefix from an RSVP status.
 *
 *  `community.lexicon.calendar.rsvp#going` -> `going`. Bare short forms are
 *  passed through untouched, so both wire formats normalize to the same thing. */
export function normalizeRsvpStatus(status: unknown): string {
	let raw = typeof status === 'string' && status ? status : 'interested';
	if (raw.includes('#')) raw = raw.split('#').pop() || 'interested';
	return raw;
}

/** Transform one applied RSVP record into the intake call that should follow.
 *
 *  Deletes address the RSVP by its own at:// URI via the `sourceId` query
 *  param — derivable from the identity a contrail `deleted` event carries. */
export function rsvpRequestFor(e: SinkRecordEvent): TransformResult {
	if (e.collection !== RSVP_COLLECTION) return skip(`not an rsvp collection: ${e.collection}`);

	const sourceId = `at://${e.did}/${e.collection}/${e.rkey}`;

	if (e.kind === 'deleted') {
		return {
			kind: 'request',
			request: {
				method: 'DELETE',
				path: '/api/integration/rsvps',
				query: { sourceId, sourceType: 'bluesky' },
				tolerate: [404]
			}
		};
	}

	const record = e.record;
	if (!record) return skip(`missing record: ${e.did}`);

	// The RSVP's author is the record's repo owner. `creator.handle` is a
	// courtesy field some clients set; absent it, the DID stands in as the
	// handle (matching the original's `creatorDid.split('/').pop()`, which for a
	// plain DID is the DID itself).
	const creator = record.creator as Record<string, unknown> | undefined;
	const creatorHandle =
		creator?.handle && typeof creator.handle === 'string'
			? creator.handle
			: e.did.split('/').pop() || 'unknown';

	if (!record.subject) return skip(`no subject reference in rsvp record: ${sourceId}`);
	const subject = readSubject(record.subject);
	if ('error' in subject) return skip(`${subject.error}: ${sourceId}`);

	// The subject must be a well-formed at:// URI with authority/collection/rkey.
	// An RSVP pointing at anything else has no event to attach to.
	if (!subject.uri.startsWith('at://')) {
		return skip(`event uri is not in AT Protocol format: ${subject.uri}`);
	}
	if (subject.uri.replace('at://', '').split('/').length < 3) {
		return skip(`invalid AT Protocol URI format: ${subject.uri}`);
	}

	const status = normalizeRsvpStatus(record.status);
	if (!(RSVP_STATUSES as readonly string[]).includes(status)) {
		return skip(`invalid rsvp status: ${status}`);
	}

	// The original fell back to the jetstream commit's wall-clock `time` when a
	// record carried no createdAt. contrail has no such field, so the fallback
	// is derived from `time_us` (microseconds since epoch) instead — same
	// meaning, different source.
	const timestamp =
		record.createdAt && typeof record.createdAt === 'string'
			? record.createdAt
			: new Date(e.time_us / 1000).toISOString();

	const body = {
		eventSourceId: subject.uri,
		eventSourceType: 'bluesky',
		userDid: e.did,
		userHandle: creatorHandle,
		status,
		timestamp,
		sourceId,
		metadata: {
			cid: e.cid,
			rkey: e.rkey || undefined,
			collection: e.collection,
			// `rev` omitted — contrail carries no commit rev. See event-transform.
			time_us: e.time_us,
			eventUri: subject.uri,
			eventCid: subject.cid
		}
	};

	return {
		kind: 'request',
		request: {
			method: 'POST',
			path: '/api/integration/rsvps',
			body,
			tolerate: [409]
		}
	};
}

export type { IntakeRequest };
