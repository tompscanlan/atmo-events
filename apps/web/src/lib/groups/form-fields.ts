// Field schemas for the group forms. A plain module, because a `*.remote.ts` may
// export only remote functions, and the remotes and their tests share these.
import * as v from 'valibot';
import { isDid, isHandle } from '@atcute/lexicons/syntax';
import { GROUP_VISIBILITIES } from './types';
import { ASSIGNABLE_ROLES } from './permissions';
import { GROUP_LABEL_PATTERN } from './handle-label';
import { EVENT_PLACEMENTS } from './event-placement';
import { RSVP_STATUSES } from './ids';

/** The shortest group account password the create form takes. A floor of this
 *  app's choosing: the creator, not this app, guards the account from then on. */
export const GROUP_PASSWORD_MIN_LENGTH = 8;

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

/** The group key every form posts, and the subject DID on the roster forms.
 *  `groupRequestContext` also accepts a full handle, but the app's forms post
 *  the DID. */
export const didField = v.pipe(
	v.string(),
	v.regex(/^did:[a-z]+:[a-zA-Z0-9._:%-]{1,300}$/, 'Invalid DID')
);

/** Shape only. `runCreateGroup` applies the stricter rules for a new label
 *  (`labelMintRefusal`). */
export const labelField = v.pipe(
	v.string(),
	v.regex(GROUP_LABEL_PATTERN, 'Invalid group handle label')
);

export const idField = v.pipe(v.string(), v.minLength(1), v.maxLength(64));

/** No `owner`: a SQL trigger pins it to `groups.owner_did`. A picklist, not a
 *  `v.check`, so the output type is the role union the roster calls take. */
export const assignableRoleField = v.picklist(ASSIGNABLE_ROLES, 'Unknown role');

export const rkeyField = v.pipe(
	v.string(),
	v.regex(/^[a-zA-Z0-9._:~-]{1,512}$/, 'Invalid record key')
);
export const eventIntentField = v.picklist(['create', 'update'] as const);
export const placementField = v.picklist(EVENT_PLACEMENTS);

export const rsvpStatusField = v.picklist(RSVP_STATUSES);
/** Shape only: the module reads a marker it did not make as none. */
export const askedField = v.nullable(v.pipe(v.string(), v.maxLength(2100)));

/** What the create form and the settings form both edit about a group. */
export const groupSettingsFields = {
	name: v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(120)),
	description: v.optional(v.pipe(v.string(), v.maxLength(4000))),
	visibility: v.picklist(GROUP_VISIBILITIES),
	requireApproval: checkboxField,
	rules: v.optional(v.pipe(v.string(), v.maxLength(8000)))
};
