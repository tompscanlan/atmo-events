// The profile and rule record shapes. Two rules here would pass a "does it
// round-trip" test while being wrong:
//
//   1. a group the host reads as private, or whose visibility is unknown, is
//      invite-only, whatever the approval flag or the profile says;
//   2. an unrecognized join policy must fail closed, because this value comes
//      off a PDS and decides whether strangers can walk into a group.
import { describe, it, expect } from 'vitest';
import {
	approvalRefusal,
	groupFace,
	groupRuleRecord,
	joinPolicyFor,
	parseGroupProfile
} from './about-record';

describe('joinPolicyFor', () => {
	// Private means invite-only, so visibility is consulted before
	// require_approval. The forms refuse a private group with approval off
	// (`approvalRefusal`), but the mapping must not depend on that.
	it('reads private as invite regardless of require_approval', () => {
		expect(joinPolicyFor('private', 1)).toBe('invite');
		expect(joinPolicyFor('private', 0)).toBe('invite');
	});

	it('distinguishes approval from open for a public group', () => {
		expect(joinPolicyFor('public', 1)).toBe('approval');
		expect(joinPolicyFor('public', 0)).toBe('open');
	});

	// A host nobody could ask is not a public group, the same way a join is
	// refused then.
	it('reads an unknown visibility as invite', () => {
		expect(joinPolicyFor(null, 0)).toBe('invite');
	});
});

describe('approvalRefusal', () => {
	it('refuses only a private group with approval off', () => {
		expect(approvalRefusal('private', false)).toBe(
			'A private group must require approval to join. Invite members instead.'
		);
		expect(approvalRefusal('private', true)).toBeNull();
		expect(approvalRefusal('public', false)).toBeNull();
		// Absent means approval on, as everywhere else.
		expect(approvalRefusal('private', undefined)).toBeNull();
	});
});

describe('parseGroupProfile', () => {
	// Fail closed. This value came off a PDS and gates whether a stranger can
	// self-serve their way in, so an unknown policy must read as the most
	// restrictive one, never as `open`.
	it('reads an unknown or missing joinPolicy as invite, not open', () => {
		expect(parseGroupProfile({ displayName: 'Kona', joinPolicy: 'everyone' })?.joinPolicy).toBe(
			'invite'
		);
		expect(parseGroupProfile({ displayName: 'Kona' })?.joinPolicy).toBe('invite');
	});

	// A page must still render for a record an older build wrote, so tolerance
	// is the contract. But a record with no name is not a profile.
	it('rejects a value with no usable displayName', () => {
		expect(parseGroupProfile({ displayName: '   ' })).toBeNull();
		expect(parseGroupProfile({ description: 'no name here' })).toBeNull();
		expect(parseGroupProfile(null)).toBeNull();
		expect(parseGroupProfile('Kona')).toBeNull();
	});
});

// Where the page's face comes from. A profile record is authoritative for every
// field it owns, including the ones it leaves null: a null description is a
// group that has none, not a record that forgot to say. A per-field `??` cannot
// tell those apart, and would let a stale or corrupted row leak into a page
// that says it renders from records.
describe('groupFace', () => {
	const row = {
		name: 'ZZZ CORRUPTED CACHE',
		description: 'CORRUPTED DESCRIPTION',
		location_name: 'CORRUPTED LOCATION',
		require_approval: 1
	};

	it("renders a record's null as null, not the row's value", () => {
		const face = groupFace(
			{
				name: 'Kona',
				description: null,
				joinPolicy: 'open',
				locationName: null,
				createdAt: null
			},
			row,
			'public'
		);
		expect(face).toEqual({
			source: 'records',
			name: 'Kona',
			description: null,
			locationName: null,
			joinPolicy: 'open'
		});
	});

	const openProfile = {
		name: 'Kona',
		description: null,
		joinPolicy: 'open' as const,
		locationName: null,
		createdAt: null
	};

	// The join policy is derived, not stored: a group is invite-only when its
	// host reads it as private, whatever the profile record or the row says. Any
	// client can change the host's read policy without touching our records, so
	// a stored "private means approval" could never stay true.
	it('a private group shows invite-only whatever its profile says', () => {
		expect(groupFace(openProfile, row, 'private').joinPolicy).toBe('invite');
		expect(groupFace({ ...openProfile, joinPolicy: 'approval' }, row, 'private').joinPolicy).toBe(
			'invite'
		);
		// A public group shows what its profile published.
		expect(groupFace(openProfile, row, 'public').joinPolicy).toBe('open');
	});

	// A host nobody could ask is not a public one, which is also how a join is
	// refused then.
	it('a group whose visibility is unknown shows invite-only', () => {
		expect(groupFace(openProfile, row, null).joinPolicy).toBe('invite');
		expect(groupFace(null, { ...row, require_approval: 0 }, null).joinPolicy).toBe('invite');
	});
});

describe('rules', () => {
	// A grapheme is what a reader sees as one character. Cutting by UTF-16 unit
	// would split an emoji and count it as several.
	it('counts graphemes, not code units, so an emoji is never split', () => {
		// One grapheme of two code points and four UTF-16 units.
		const thumbsUp = '\u{1F44D}\u{1F3FD}';
		const title = groupRuleRecord({ text: thumbsUp.repeat(70), order: 0 }).title as string;
		expect(title).toBe(thumbsUp.repeat(64));
	});

	// The title's other bound is 640 bytes. Only a line of heavily combined
	// characters reaches it before 64 graphemes, and the title stops short then.
	it('stops the title before it would pass 640 bytes', () => {
		const heavy = `e${'\u0301'.repeat(10)}`;
		const title = groupRuleRecord({ text: heavy.repeat(64), order: 0 }).title as string;
		expect(new TextEncoder().encode(title).length).toBeLessThanOrEqual(640);
		expect(title).toBe(heavy.repeat(Math.floor(640 / new TextEncoder().encode(heavy).length)));
	});
});
