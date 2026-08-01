// Shared types for the OpenMeet intake sink.
//
// Deliberately dependency-free: nothing here imports from contrail, from
// SvelteKit, or from the rest of atmo. The record shape is declared
// STRUCTURALLY rather than imported from `@atmo-dev/contrail`, so contrail's
// own `RecordEvent` is assignable to it without this module depending on the
// package. That is what keeps the transform layer liftable — the same files can
// later back an out-of-process webhook consumer or a standalone npm package
// with no edits (see the sink's header for why that matters).

/** One applied record, mirroring contrail's `RecordEvent` structurally.
 *
 *  Note the asymmetry, which is contrail's and not ours: `deleted` carries
 *  IDENTITY ONLY — no `record`, no `cid`, no `time_us`. Every delete path here
 *  is therefore restricted to what can be derived from did/collection/rkey. */
export type SinkRecordEvent =
	| {
			kind: 'created';
			uri: string;
			did: string;
			collection: string;
			rkey: string;
			cid: string | null;
			record: Record<string, unknown>;
			time_us: number;
	  }
	| {
			kind: 'deleted';
			uri: string;
			did: string;
			collection: string;
			rkey: string;
	  };

/** The two collections this sink feeds. Anything else is ignored outright. */
export const EVENT_COLLECTION = 'community.lexicon.calendar.event';
export const RSVP_COLLECTION = 'community.lexicon.calendar.rsvp';

/** A single call to the OpenMeet intake API, described as data rather than
 *  performed.
 *
 *  Keeping the transforms in the business of RETURNING requests instead of
 *  ISSUING them is what makes them testable without a fetch mock, and what lets
 *  a future out-of-process consumer reuse them verbatim: the descriptor is the
 *  contract, and executing it is somebody else's job. */
export interface IntakeRequest {
	method: 'POST' | 'DELETE';
	/** Path only — the base URL comes from the sink's configured backend. */
	path: string;
	query?: Record<string, string>;
	body?: unknown;
	/** Status codes that are NOT failures for this request, beyond the 2xx
	 *  range. Create tolerates 409 (a race against a concurrent write); delete
	 *  tolerates 404 (already gone). Both mean "the intended end state holds",
	 *  which is the only thing an idempotent feed cares about. */
	tolerate: number[];
}

/** Statuses the OpenMeet intake API accepts for an RSVP, after the lexicon's
 *  NSID prefix is stripped. */
export const RSVP_STATUSES = ['interested', 'going', 'notgoing'] as const;
