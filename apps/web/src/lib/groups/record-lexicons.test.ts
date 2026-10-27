// Every record atmo writes, checked against the proposal's lexicon for its collection
// (lexicons/reference). Stricter than a PDS: an undeclared field fails.
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
	GROUP_PROFILE_COLLECTION,
	GROUP_RULE_COLLECTION,
	groupProfileRecord,
	groupRuleRecord
} from './about-record';
import { GROUP_DECLARATION_COLLECTION, groupDeclarationRecord } from './declaration-record';
import {
	ABOUT_SPACE_READER_ROLES,
	GROUP_ACCESS_COLLECTION,
	GROUP_MEMBERSHIP_COLLECTION,
	groupAccessRecord,
	groupMembershipRecord
} from './members-record';
import { ABOUT_SPACE_TYPE, MEMBERS_SPACE_TYPE } from './types';
import { spaceUri } from './ids';

const REFERENCE_DIR = new URL('../../../lexicons/reference/group/opensocial/', import.meta.url);

interface LexSchema {
	type: string;
	[key: string]: unknown;
}

interface Lexicon {
	id: string;
	defs: Record<string, LexSchema>;
}

const LEXICONS = new Map<string, Lexicon>(
	['declaration', 'profile', 'rule', 'membership', 'access', 'defs'].map((name) => {
		const doc = JSON.parse(readFileSync(new URL(`${name}.json`, REFERENCE_DIR), 'utf8')) as Lexicon;
		return [doc.id, doc];
	})
);

const segmenter = new Intl.Segmenter();
const graphemes = (value: string) => [...segmenter.segment(value)].length;
const bytes = (value: string) => new TextEncoder().encode(value).length;

/** A format this table lacks fails the check, so a new one cannot pass unexamined. */
const FORMATS: Readonly<Record<string, (value: string) => boolean>> = {
	did: (v) => /^did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]$/.test(v),
	datetime: (v) =>
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v) &&
		!Number.isNaN(Date.parse(v)),
	uri: (v) => /^[a-zA-Z][a-zA-Z0-9+.-]*:\S+$/.test(v),
	'record-key': (v) => /^[a-zA-Z0-9_~.:-]{1,512}$/.test(v) && v !== '.' && v !== '..',
	'space-ref': (v) =>
		/^at:\/\/did:[a-z]+:[a-zA-Z0-9._:%-]+\/space\/[a-zA-Z0-9.-]+\/[^/\s]+$/.test(v)
};

function resolveRef(ref: string, from: string): { schema: LexSchema; nsid: string } {
	const [target, name = 'main'] = ref.split('#');
	const nsid = target || from;
	const schema = LEXICONS.get(nsid)?.defs[name];
	if (!schema) throw new Error(`${from} refers to ${ref}, which is not in the reference lexicons`);
	return { schema, nsid };
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every way `value` breaks `schema`, as `path: problem`. */
function violations(schema: LexSchema, value: unknown, path: string, nsid: string): string[] {
	const found: string[] = [];
	const n = (key: string) => schema[key] as number | undefined;
	switch (schema.type) {
		case 'ref': {
			const target = resolveRef(schema.ref as string, nsid);
			return violations(target.schema, value, path, target.nsid);
		}
		case 'string': {
			if (typeof value !== 'string') return [`${path}: expected a string`];
			if (n('maxLength') !== undefined && bytes(value) > n('maxLength')!)
				found.push(`${path}: over ${n('maxLength')} bytes`);
			if (n('minLength') !== undefined && bytes(value) < n('minLength')!)
				found.push(`${path}: under ${n('minLength')} bytes`);
			if (n('maxGraphemes') !== undefined && graphemes(value) > n('maxGraphemes')!)
				found.push(`${path}: over ${n('maxGraphemes')} graphemes`);
			const format = schema.format as string | undefined;
			if (format !== undefined) {
				const check = FORMATS[format];
				if (!check) found.push(`${path}: this test does not know the format ${format}`);
				else if (!check(value)) found.push(`${path}: not a ${format}`);
			}
			const allowed = schema.enum as string[] | undefined;
			if (allowed && !allowed.includes(value)) found.push(`${path}: not one of ${allowed}`);
			return found;
		}
		case 'integer': {
			if (!Number.isInteger(value)) return [`${path}: expected an integer`];
			if (n('minimum') !== undefined && (value as number) < n('minimum')!)
				found.push(`${path}: under ${n('minimum')}`);
			if (n('maximum') !== undefined && (value as number) > n('maximum')!)
				found.push(`${path}: over ${n('maximum')}`);
			return found;
		}
		case 'boolean':
			return typeof value === 'boolean' ? [] : [`${path}: expected a boolean`];
		case 'blob': {
			const ref = isObject(value) && isObject(value.ref) ? value.ref.$link : undefined;
			if (!isObject(value) || value.$type !== 'blob' || typeof ref !== 'string')
				return [`${path}: expected a blob reference`];
			const accept = schema.accept as string[] | undefined;
			if (typeof value.mimeType !== 'string' || (accept && !accept.includes(value.mimeType)))
				found.push(`${path}: type ${String(value.mimeType)} not accepted`);
			if (!Number.isInteger(value.size)) found.push(`${path}: size is not an integer`);
			else if (n('maxSize') !== undefined && (value.size as number) > n('maxSize')!)
				found.push(`${path}: over ${n('maxSize')} bytes`);
			return found;
		}
		case 'array': {
			if (!Array.isArray(value)) return [`${path}: expected an array`];
			if (n('maxLength') !== undefined && value.length > n('maxLength')!)
				found.push(`${path}: over ${n('maxLength')} items`);
			value.forEach((item, i) =>
				found.push(...violations(schema.items as LexSchema, item, `${path}[${i}]`, nsid))
			);
			return found;
		}
		case 'object': {
			if (!isObject(value)) return [`${path}: expected an object`];
			const properties = (schema.properties ?? {}) as Record<string, LexSchema>;
			for (const key of (schema.required ?? []) as string[]) {
				if (!(key in value)) found.push(`${path}.${key}: required and missing`);
			}
			for (const [key, field] of Object.entries(value)) {
				const declared = properties[key];
				if (declared) found.push(...violations(declared, field, `${path}.${key}`, nsid));
				else found.push(`${path}.${key}: not in the lexicon`);
			}
			return found;
		}
		default:
			return [`${path}: this test does not check a ${schema.type}`];
	}
}

/** Checked against the lexicon of the collection its writer files it under. */
function recordViolations(collection: string, body: Record<string, unknown>): string[] {
	const main = LEXICONS.get(collection)?.defs.main;
	if (!main || main.type !== 'record') return [`${collection}: no record lexicon`];
	const { $type, ...fields } = body;
	if ($type !== undefined && $type !== collection) return [`$type ${$type} is not ${collection}`];
	return violations(main.record as LexSchema, fields, collection, collection);
}

const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const BLOB = {
	$type: 'blob',
	ref: { $link: 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku' },
	mimeType: 'image/jpeg',
	size: 1_999_999
};

describe('the checker', () => {
	it('fails a missing required field, an undeclared field, a wrong type and a bound', () => {
		expect(recordViolations(GROUP_PROFILE_COLLECTION, { joinPolicy: 'open' })).toEqual([
			'group.opensocial.profile.displayName: required and missing'
		]);
		expect(
			recordViolations(GROUP_PROFILE_COLLECTION, {
				displayName: 'Kona',
				joinPolicy: 'open',
				location: 'x'
			})
		).toEqual(['group.opensocial.profile.location: not in the lexicon']);
		expect(recordViolations(GROUP_ACCESS_COLLECTION, { public: 'no', grants: [] })).toEqual([
			'group.opensocial.access.public: expected a boolean'
		]);
		expect(
			recordViolations(GROUP_RULE_COLLECTION, { title: 'x'.repeat(65), text: 'x', order: -1 })
		).toEqual([
			'group.opensocial.rule.title: over 64 graphemes',
			'group.opensocial.rule.order: under 0'
		]);
		expect(
			recordViolations(GROUP_PROFILE_COLLECTION, {
				displayName: 'Kona',
				joinPolicy: 'open',
				avatar: { ...BLOB, mimeType: 'image/gif', size: 2_000_001 }
			})
		).toEqual([
			'group.opensocial.profile.avatar: type image/gif not accepted',
			'group.opensocial.profile.avatar: over 2000000 bytes'
		]);
	});
});

describe('every record atmo writes matches its group.opensocial lexicon', () => {
	it('declaration, naming the meta space at self', () => {
		const meta = spaceUri(GROUP_DID, ABOUT_SPACE_TYPE, 'self');
		const record = groupDeclarationRecord({ aboutSpaceUri: meta });
		expect(recordViolations(GROUP_DECLARATION_COLLECTION, record)).toEqual([]);
		expect(record).toEqual({ meta: `at://${GROUP_DID}/space/group.opensocial.meta/self` });
	});

	it('profile, bare and over a record whose other fields it keeps', () => {
		const base = { avatar: BLOB, banner: BLOB, url: 'https://kona.example' };
		for (const record of [
			groupProfileRecord({ name: 'Kona', joinPolicy: 'open' }),
			groupProfileRecord({ name: 'Kona', description: 'Weekly runs', joinPolicy: 'invite', base })
		]) {
			expect(recordViolations(GROUP_PROFILE_COLLECTION, record)).toEqual([]);
		}
	});

	it.each([
		'Be kind',
		`${'Leave every trailhead cleaner than you found it, '.repeat(5)}and say so.`,
		'\u{1F6B4}\u{1F3FD}'.repeat(90)
	])('rule %#', (text) => {
		expect(recordViolations(GROUP_RULE_COLLECTION, groupRuleRecord({ text, order: 0 }))).toEqual(
			[]
		);
	});

	it('membership', () => {
		const record = groupMembershipRecord({
			subject: 'did:plc:6cz6dldz42itymdbte47ewcv',
			roles: ['admin'],
			createdAt: '2026-09-30T12:00:00.000Z'
		});
		expect(recordViolations(GROUP_MEMBERSHIP_COLLECTION, record)).toEqual([]);
	});

	it.each([
		[ABOUT_SPACE_TYPE, true],
		[ABOUT_SPACE_TYPE, false],
		[MEMBERS_SPACE_TYPE, false]
	])('access for %s, public %s', (spaceType, isPublic) => {
		const record = groupAccessRecord({
			spaceType,
			roles: ABOUT_SPACE_READER_ROLES,
			public: isPublic
		});
		expect(recordViolations(GROUP_ACCESS_COLLECTION, record)).toEqual([]);
	});
});
