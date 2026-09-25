// The profile and rule record shapes. Two rules here would pass a "does it
// round-trip" test while being wrong:
//
//   1. the join-policy mapping is one-way, and must not be inverted even though
//      it could be;
//   2. an unrecognized join policy must fail closed, because this value comes
//      off a PDS and decides whether strangers can walk into a group.
import { describe, it, expect } from 'vitest';
import {
	groupFace,
	groupProfileRecord,
	groupRuleRecord,
	joinPolicyFor,
	parseGroupProfile,
	parseGroupRule,
	requireApprovalFor,
	splitRuleLines
} from './about-record';

describe('joinPolicyFor', () => {
	// Private means invite-only, so visibility is consulted before
	// require_approval. migrations/0001_groups.sql refuses a private group with
	// require_approval = 0, but the mapping must not depend on that.
	it('reads private as invite regardless of require_approval', () => {
		expect(joinPolicyFor({ visibility: 'private', require_approval: 1 })).toBe('invite');
		expect(joinPolicyFor({ visibility: 'private', require_approval: 0 })).toBe('invite');
	});

	it('distinguishes approval from open for a public group', () => {
		expect(joinPolicyFor({ visibility: 'public', require_approval: 1 })).toBe('approval');
		expect(joinPolicyFor({ visibility: 'public', require_approval: 0 })).toBe('open');
	});
});

describe('requireApprovalFor', () => {
	// The inverse is partial on purpose. Only `private` maps to `invite`, so the
	// mapping looks invertible, but a rebuild that inverted it would forbid a
	// public group from ever being invite-only. What comes back is the approval
	// flag and nothing else; the stored visibility is what `about-read.ts` keeps.
	it('restores require_approval and nothing else', () => {
		expect(requireApprovalFor('open')).toBe(0);
		expect(requireApprovalFor('approval')).toBe(1);
		expect(requireApprovalFor('invite')).toBe(1);
	});
});

describe('groupProfileRecord', () => {
	it('carries the location NAME as the declared extension, and only the name', () => {
		const record = groupProfileRecord({
			name: 'Kona',
			joinPolicy: 'open',
			locationName: '  Kailua-Kona  ',
			createdAt: '2026-09-01T12:00:00.000Z'
		});
		expect(record.location).toEqual({ name: 'Kailua-Kona' });
	});

	// An empty or whitespace location is not a location: an empty object under
	// `location` would make every reader handle a case we never meant to write.
	it('omits location entirely when there is no name', () => {
		expect(groupProfileRecord({ name: 'Kona', joinPolicy: 'open' })).not.toHaveProperty('location');
		expect(
			groupProfileRecord({ name: 'Kona', joinPolicy: 'open', locationName: '   ' })
		).not.toHaveProperty('location');
	});

	it('omits description rather than writing an empty string', () => {
		expect(
			groupProfileRecord({ name: 'Kona', joinPolicy: 'open', description: '  ' })
		).not.toHaveProperty('description');
	});

	// The draft's profile has an avatar and ours deliberately does not: moving a
	// blob between repos is its own problem, and no group UI uploads one. An
	// omission that is a decision gets asserted, or the next writer "fixes" it.
	it('writes no avatar', () => {
		expect(groupProfileRecord({ name: 'Kona', joinPolicy: 'open' })).not.toHaveProperty('avatar');
	});

	it('preserves a supplied createdAt so an edit does not restamp the group', () => {
		const record = groupProfileRecord({
			name: 'Kona',
			joinPolicy: 'open',
			createdAt: '2026-02-16T04:19:23.810Z'
		});
		expect(record.createdAt).toBe('2026-02-16T04:19:23.810Z');
	});
});

describe('parseGroupProfile', () => {
	it('round-trips a record this build wrote', () => {
		const record = groupProfileRecord({
			name: 'Kona',
			description: 'Weekly rides',
			joinPolicy: 'approval',
			locationName: 'Kailua-Kona',
			createdAt: '2026-09-01T12:00:00.000Z'
		});
		expect(parseGroupProfile(record)).toEqual({
			name: 'Kona',
			description: 'Weekly rides',
			joinPolicy: 'approval',
			locationName: 'Kailua-Kona',
			createdAt: '2026-09-01T12:00:00.000Z'
		});
	});

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

	it('survives a location that is not the shape we write', () => {
		expect(parseGroupProfile({ displayName: 'Kona', location: 'Kona' })?.locationName).toBeNull();
		expect(
			parseGroupProfile({ displayName: 'Kona', location: { name: 7 } })?.locationName
		).toBeNull();
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
		visibility: 'public',
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
			row
		);
		expect(face).toEqual({
			source: 'records',
			name: 'Kona',
			description: null,
			locationName: null,
			joinPolicy: 'open'
		});
	});

	it('renders the row, and says so, only when there is no record', () => {
		expect(groupFace(null, row)).toEqual({
			source: 'cache',
			name: 'ZZZ CORRUPTED CACHE',
			description: 'CORRUPTED DESCRIPTION',
			locationName: 'CORRUPTED LOCATION',
			joinPolicy: 'approval'
		});
	});
});

describe('rules', () => {
	it('round-trips text and the declared order extension', () => {
		const record = groupRuleRecord({ text: '  Be kind  ', order: 2 });
		expect(record.text).toBe('Be kind');
		expect(record.order).toBe(2);
		expect(parseGroupRule(record)).toMatchObject({ text: 'Be kind', order: 2 });
	});

	// A reader that does not know `order` gets an unordered set (that is what
	// the draft promises), so a record without it must still parse.
	it('parses a rule with no order as order 0 rather than failing', () => {
		expect(parseGroupRule({ text: 'Be kind' })).toMatchObject({ text: 'Be kind', order: 0 });
	});

	it('rejects a rule with no text', () => {
		expect(parseGroupRule({ order: 0 })).toBeNull();
		expect(parseGroupRule({ text: '  ', order: 0 })).toBeNull();
	});

	it('splits the textarea on lines, dropping blanks and trimming', () => {
		expect(splitRuleLines('Be kind\n\n  No spam  \n\n')).toEqual(['Be kind', 'No spam']);
		expect(splitRuleLines('')).toEqual([]);
		expect(splitRuleLines(null)).toEqual([]);
	});
});
