// Field schemas for the group forms; a `*.remote.ts` may export only remote functions.
import * as v from 'valibot';
import { isDid, isHandle } from '@atcute/lexicons/syntax';
import {
	GROUP_DESCRIPTION_MAX,
	GROUP_DESCRIPTION_MAX_BYTES,
	GROUP_JOIN_POLICIES,
	GROUP_NAME_MAX,
	GROUP_NAME_MAX_BYTES,
	GROUP_RULE_MAX,
	GROUP_RULE_MAX_BYTES,
	graphemeLength,
	splitRuleLines
} from './about-record';
import { EVENT_PLACEMENTS } from './event-placement';
import { RSVP_STATUSES } from './ids';
import { GROUP_VISIBILITIES } from './types';

const utf8 = new TextEncoder();
import { ASSIGNABLE_ROLES } from './permissions';

/** An unticked checkbox sends nothing, and without the `''` default valibot skips the
 *  missing key, so it would parse to `undefined` instead of `false`. */
export const checkboxField = v.pipe(
	v.optional(v.string(), ''),
	v.transform((value) => value !== '')
);

/** Empty or missing parses to `undefined`, "shown unknown". */
export const shownVisibilityField = v.pipe(
	v.optional(v.union([v.literal(''), v.picklist(GROUP_VISIBILITIES)]), ''),
	v.transform((value) => (value === '' ? undefined : value))
);

export type MemberActor = { did: string } | { handle: string };

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

export const didField = v.pipe(
	v.string(),
	v.regex(/^did:[a-z]+:[a-zA-Z0-9._:%-]{1,300}$/, 'Invalid DID')
);

export const assignableRoleField = v.picklist(ASSIGNABLE_ROLES, 'Unknown role');

export const rkeyField = v.pipe(
	v.string(),
	v.regex(/^[a-zA-Z0-9._:~-]{1,512}$/, 'Invalid record key')
);
export const eventIntentField = v.picklist(['create', 'update'] as const);

export const placementField = v.picklist(EVENT_PLACEMENTS, 'Say who can see the event');

export const rsvpStatusField = v.picklist(RSVP_STATUSES, 'Unknown RSVP');

/** Within the lexicon's bounds. */
export const groupSettingsFields = {
	name: v.pipe(
		v.string(),
		v.trim(),
		v.nonEmpty('Enter a name.'),
		v.maxGraphemes(GROUP_NAME_MAX),
		v.maxBytes(GROUP_NAME_MAX_BYTES)
	),
	description: v.optional(
		v.pipe(
			v.string(),
			v.maxGraphemes(GROUP_DESCRIPTION_MAX),
			v.maxBytes(GROUP_DESCRIPTION_MAX_BYTES)
		)
	),
	visibility: v.picklist(GROUP_VISIBILITIES),
	joinPolicy: v.picklist(GROUP_JOIN_POLICIES),
	listed: checkboxField
};

export const groupRulesField = v.optional(
	v.pipe(
		v.string(),
		v.check(
			(value) =>
				splitRuleLines(value).every(
					(rule) =>
						graphemeLength(rule) <= GROUP_RULE_MAX &&
						utf8.encode(rule).length <= GROUP_RULE_MAX_BYTES
				),
			`A rule can be at most ${GROUP_RULE_MAX} characters.`
		)
	)
);
