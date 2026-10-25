// Field schemas for the group forms; a `*.remote.ts` may export only remote functions.
import * as v from 'valibot';
import { isDid, isHandle } from '@atcute/lexicons/syntax';
import {
	GROUP_DESCRIPTION_MAX,
	GROUP_JOIN_POLICIES,
	GROUP_NAME_MAX,
	GROUP_RULE_MAX,
	graphemeLength,
	splitRuleLines
} from './about-record';
import { GROUP_VISIBILITIES } from './types';
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

export const idField = v.pipe(v.string(), v.minLength(1), v.maxLength(64));

export const assignableRoleField = v.picklist(ASSIGNABLE_ROLES, 'Unknown role');

export const rkeyField = v.pipe(
	v.string(),
	v.regex(/^[a-zA-Z0-9._:~-]{1,512}$/, 'Invalid record key')
);
export const eventIntentField = v.picklist(['create', 'update'] as const);

/** Within the lexicon's bounds. */
export const groupSettingsFields = {
	name: v.pipe(v.string(), v.trim(), v.nonEmpty('Enter a name.'), v.maxGraphemes(GROUP_NAME_MAX)),
	description: v.optional(v.pipe(v.string(), v.maxGraphemes(GROUP_DESCRIPTION_MAX))),
	visibility: v.picklist(GROUP_VISIBILITIES),
	joinPolicy: v.picklist(GROUP_JOIN_POLICIES),
	listed: checkboxField
};

export const groupRulesField = v.optional(
	v.pipe(
		v.string(),
		v.check(
			(value) => splitRuleLines(value).every((rule) => graphemeLength(rule) <= GROUP_RULE_MAX),
			`A rule can be at most ${GROUP_RULE_MAX} characters.`
		)
	)
);
