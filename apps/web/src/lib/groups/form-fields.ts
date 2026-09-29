// Field schemas for the group forms, outside `groups.remote.ts` so tests can import them.
import * as v from 'valibot';
import { isDid, isHandle } from '@atcute/lexicons/syntax';
import { GROUP_VISIBILITIES } from './types';

/** An HTML checkbox sends `on` when ticked and nothing when not. The `''` default is
 *  required: without it valibot skips a missing key, the transform never runs, and an
 *  unticked box parses to `undefined` ("not supplied") instead of `false`. */
export const checkboxField = v.pipe(
	v.optional(v.string(), ''),
	v.transform((value) => value !== '')
);

/** The visibility the settings form showed, so the save changes it only when the
 *  choice differs. Empty or missing parses to `undefined`, "shown unknown". */
export const shownVisibilityField = v.pipe(
	v.optional(v.union([v.literal(''), v.picklist(GROUP_VISIBILITIES)]), ''),
	v.transform((value) => (value === '' ? undefined : value))
);

/** Who an admin asked to add: a DID, or a handle still to resolve. */
export type MemberActor = { did: string } | { handle: string };

/** Someone to add, as an admin types them: a handle, with or without its `@`, or a
 *  DID. Parses to the one the input is; the handler resolves a handle to its DID. */
export const memberActorField = v.pipe(
	v.string(),
	v.trim(),
	v.transform((value) => value.replace(/^@/, '')),
	v.check(
		(value) => isDid(value) || isHandle(value),
		'Enter a handle, like alice.bsky.social, or a DID.'
	),
	v.transform(
		(value): MemberActor => (isDid(value) ? { did: value } : { handle: value.toLowerCase() })
	)
);
