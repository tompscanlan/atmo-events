// Every record builder's output, checked against the lexicon it claims to be.
// The lexicons are copies of the opensocial.group proposal's group.opensocial
// records at d2c89a9, kept in lexicons/reference/group/opensocial and outside
// codegen, which cannot read them.
//
// This is stricter than a PDS. A lexicon object is open, so a validating PDS
// accepts a field the lexicon does not declare, and a PDS that does not know the
// lexicon validates nothing at all. Here an undeclared field fails unless the
// allowlist below names it, with the reason the app writes it.
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
	GROUP_PERMISSIONS_COLLECTION,
	GROUP_ROLE_COLLECTION,
	GROUP_SPACE_COLLECTION,
	MEMBERS_SPACE_READER_ROLES,
	groupAccessRecord,
	groupBindingsRecord,
	groupMembershipRecord,
	groupRoleRecord,
	groupSpaceRecord,
	membershipRkey,
	GROUP_ACCEPTANCE_COLLECTION,
	GROUP_ACCEPTANCE_RKEY,
	groupAcceptanceRecord
} from './members-record';
import { DEFAULT_ROLE_PERMISSIONS, GROUP_ROLES } from './permissions';
import { spaceUri } from './server/spaces';
import { ABOUT_SPACE_TYPE, MEMBERS_SPACE_TYPE } from './types';

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
	[
		'declaration',
		'profile',
		'rule',
		'role',
		'permissions',
		'membership',
		'access',
		'space',
		'acceptance',
		'defs'
	].map((name) => {
		const doc = JSON.parse(readFileSync(new URL(`${name}.json`, REFERENCE_DIR), 'utf8')) as Lexicon;
		return [doc.id, doc];
	})
);

/** Fields a record carries beyond its lexicon, and why. Nothing else may be extra. */
const EXTRA_FIELDS: Readonly<Record<string, readonly string[]>> = {
	// The declaration index sorts by it, so browse lists the newest group first.
	'group.opensocial.declaration': ['createdAt'],
	// `location` is where an events group meets. `createdAt` is kept across an
	// edit, and a rebuild restores the group's creation date from it.
	'group.opensocial.profile': ['location', 'createdAt'],
	// Kept when a rule moves, and it breaks a tie in the rule order.
	'group.opensocial.rule': ['createdAt'],
	'group.opensocial.role': [],
	'group.opensocial.permissions': [],
	'group.opensocial.membership': [],
	'group.opensocial.access': [],
	'group.opensocial.space': [],
	'group.opensocial.acceptance': []
};

const segmenter = new Intl.Segmenter();
const graphemes = (value: string) => [...segmenter.segment(value)].length;
const bytes = (value: string) => new TextEncoder().encode(value).length;

/** The string formats these records use. A format this table lacks fails the
 *  check, so a new one cannot pass unexamined. */
const FORMATS: Readonly<Record<string, (value: string) => boolean>> = {
	did: (v) => /^did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]$/.test(v),
	datetime: (v) =>
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v) &&
		!Number.isNaN(Date.parse(v)),
	uri: (v) => /^[a-zA-Z][a-zA-Z0-9+.-]*:\S+$/.test(v),
	'record-key': (v) => /^[a-zA-Z0-9_~.:-]{1,512}$/.test(v) && v !== '.' && v !== '..',
	// The proposal's own format: at://<authority DID>/space/<space type>/<skey>.
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

/** Every way `value` breaks `schema`, as `path: problem`. `extras` applies to the
 *  top level only. */
function violations(
	schema: LexSchema,
	value: unknown,
	path: string,
	nsid: string,
	extras: readonly string[] = []
): string[] {
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
				else if (!extras.includes(key)) found.push(`${path}.${key}: not in the lexicon`);
			}
			return found;
		}
		default:
			return [`${path}: this test does not check a ${schema.type}`];
	}
}

/** A builder's output checked against the lexicon of the collection its writer
 *  files it under, so a collection name that is not a lexicon id fails too. */
function recordViolations(collection: string, body: Record<string, unknown>): string[] {
	const main = LEXICONS.get(collection)?.defs.main;
	if (!main || main.type !== 'record') return [`${collection}: no record lexicon`];
	// `$type` is stamped by the writer, which owns the collection name.
	const { $type, ...fields } = body;
	if ($type !== undefined && $type !== collection) return [`$type ${$type} is not ${collection}`];
	return violations(
		main.record as LexSchema,
		fields,
		collection,
		collection,
		EXTRA_FIELDS[collection] ?? []
	);
}

const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const MEMBER = 'did:plc:6cz6dldz42itymdbte47ewcv';
const CREATED_AT = '2026-09-30T12:00:00.000Z';

describe('the checker', () => {
	// A checker that passes everything would make every case below pass too.
	it('fails a missing required field, an undeclared field and a wrong type', () => {
		expect(recordViolations(GROUP_ROLE_COLLECTION, {})).toEqual([
			'group.opensocial.role.displayName: required and missing'
		]);
		expect(recordViolations(GROUP_ROLE_COLLECTION, { displayName: 'Admin', id: 'admin' })).toEqual([
			'group.opensocial.role.id: not in the lexicon'
		]);
		expect(
			recordViolations(GROUP_ACCESS_COLLECTION, { public: 'no', readRoles: [], grants: [] })
		).toEqual(['group.opensocial.access.public: expected a boolean']);
		expect(
			recordViolations(GROUP_RULE_COLLECTION, { title: 'x'.repeat(65), text: 'x', order: -1 })
		).toEqual([
			'group.opensocial.rule.title: over 64 graphemes',
			'group.opensocial.rule.order: under 0'
		]);
	});

	it('allows only extra fields the lexicon does not already declare', () => {
		for (const [collection, extras] of Object.entries(EXTRA_FIELDS)) {
			const main = LEXICONS.get(collection)?.defs.main;
			const declared = Object.keys(
				((main?.record as LexSchema | undefined)?.properties ?? {}) as object
			);
			expect(main?.type, collection).toBe('record');
			for (const extra of extras) expect(declared, `${collection}.${extra}`).not.toContain(extra);
		}
	});
});

describe('every record builder matches its group.opensocial lexicon', () => {
	it('declaration', () => {
		const meta = spaceUri(GROUP_DID, ABOUT_SPACE_TYPE, 'self');
		const record = groupDeclarationRecord({ aboutSpaceUri: meta, createdAt: CREATED_AT });
		expect(recordViolations(GROUP_DECLARATION_COLLECTION, record)).toEqual([]);
		// The lexicon's own wording: it must be the author's meta space at self.
		expect(record.meta).toBe(`at://${GROUP_DID}/space/group.opensocial.meta/self`);
	});

	it('profile, with every optional field it writes and with none', () => {
		const full = groupProfileRecord({
			name: 'Kona Trail Runners',
			description: 'Weekly rides',
			joinPolicy: 'approval',
			locationName: 'Kailua-Kona',
			createdAt: CREATED_AT
		});
		expect(recordViolations(GROUP_PROFILE_COLLECTION, full)).toEqual([]);
		const bare = groupProfileRecord({ name: 'Kona', joinPolicy: 'open' });
		expect(recordViolations(GROUP_PROFILE_COLLECTION, bare)).toEqual([]);
	});

	it('rule, for a short line, a long one and one of emoji', () => {
		const lines = [
			'Be kind',
			`${'Leave every trailhead cleaner than you found it, '.repeat(5)}and say so.`,
			'\u{1F6B4}\u{1F3FD}'.repeat(90)
		];
		for (const [order, text] of lines.entries()) {
			const record = groupRuleRecord({ text, order, createdAt: CREATED_AT });
			expect(recordViolations(GROUP_RULE_COLLECTION, record), text.slice(0, 20)).toEqual([]);
		}
	});

	it('role, for every role', () => {
		for (const id of GROUP_ROLES) {
			expect(recordViolations(GROUP_ROLE_COLLECTION, groupRoleRecord({ id })), id).toEqual([]);
		}
	});

	it('permissions, binding every role once and naming only roles it binds', () => {
		const record = groupBindingsRecord({
			altitude: 'community',
			bundles: DEFAULT_ROLE_PERMISSIONS
		});
		expect(recordViolations(GROUP_PERMISSIONS_COLLECTION, record)).toEqual([]);
		// Beyond the types: the lexicon says a reader rejects an unknown role.
		const roles = record.roles as { role: string; assignable: string[] }[];
		const bound = roles.map((binding) => binding.role);
		expect(new Set(bound).size).toBe(bound.length);
		for (const binding of roles) {
			for (const role of binding.assignable) expect(bound, binding.role).toContain(role);
		}
		for (const role of record.defaultRoles as string[]) expect(bound).toContain(role);
	});

	it('membership, keyed by the member it names', () => {
		const record = groupMembershipRecord({
			subject: MEMBER,
			roles: ['admin'],
			createdAt: CREATED_AT
		});
		expect(recordViolations(GROUP_MEMBERSHIP_COLLECTION, record)).toEqual([]);
		expect(membershipRkey(MEMBER)).toBe(record.member);
	});

	it('access, for the members space', () => {
		const record = groupAccessRecord({ roles: MEMBERS_SPACE_READER_ROLES, public: false });
		expect(recordViolations(GROUP_ACCESS_COLLECTION, record)).toEqual([]);
	});

	it('access, for the about space of a public group and a private one', () => {
		for (const isPublic of [true, false]) {
			const record = groupAccessRecord({ roles: ABOUT_SPACE_READER_ROLES, public: isPublic });
			expect(recordViolations(GROUP_ACCESS_COLLECTION, record), String(isPublic)).toEqual([]);
		}
	});

	it('space, one index entry for each of the two spaces', () => {
		for (const type of [ABOUT_SPACE_TYPE, MEMBERS_SPACE_TYPE]) {
			const space = spaceUri(GROUP_DID, type, 'self');
			const record = groupSpaceRecord({ space, createdAt: CREATED_AT });
			expect(recordViolations(GROUP_SPACE_COLLECTION, record), type).toEqual([]);
			// The lexicon's own wording: the space's authority must be the group.
			expect(record.space).toBe(`at://${GROUP_DID}/space/${type}/self`);
		}
	});

	// The one record a member writes, not the group, into their own repo.
	it('acceptance, at the one key the lexicon allows', () => {
		const record = groupAcceptanceRecord({ createdAt: CREATED_AT });
		expect(recordViolations(GROUP_ACCEPTANCE_COLLECTION, record)).toEqual([]);
		expect(LEXICONS.get(GROUP_ACCEPTANCE_COLLECTION)?.defs.main.key).toBe(
			`literal:${GROUP_ACCEPTANCE_RKEY}`
		);
	});
});
