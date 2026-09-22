// The profile/rule record SHAPE. Two things here are load-bearing rather than
// plumbing, and both would pass a "does it round-trip" test while being wrong:
//
//   1. the join-policy mapping is one-way (FR-004b) — it became total when the
//      third visibility went, and must still not be inverted;
//   2. an unrecognised join policy must fail CLOSED, because this value comes
//      off a PDS and decides whether strangers can walk into a group.
import { describe, it, expect } from 'vitest';
import {
	groupProfileRecord,
	groupRuleRecord,
	joinPolicyFor,
	parseGroupProfile,
	parseGroupRule,
	requireApprovalFor,
	splitRuleLines
} from './about-record';

describe('joinPolicyFor', () => {
	// migrations/0003: private implies invite-only, so visibility is consulted
	// BEFORE require_approval. A private group with require_approval = 0 is a
	// configuration the schema refuses, but the mapping must not depend on that.
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
	// THE INVERSE IS PARTIAL ON PURPOSE, and it stayed partial when it stopped
	// being ambiguous: only `private` maps to `invite` now, so the mapping looks
	// invertible — and a rebuild that took that path would forbid a PUBLIC group
	// from ever being invite-only. What comes back is the approval flag and
	// nothing else; the stored visibility is what `about-read.ts` keeps.
	// (FR-004b.)
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

	// The draft's profile HAS an avatar and ours deliberately does not: moving a
	// blob between repos is its own problem, and no group UI uploads one yet. An
	// omission that is a decision gets asserted, or the next writer "fixes" it.
	// (Spec: FR-004d.)
	it('writes no avatar this iteration', () => {
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

	// FAIL CLOSED. This value came off a PDS and gates whether a stranger can
	// self-serve their way in, so an unknown policy must read as the most
	// restrictive one, never as `open`.
	it('reads an unknown or missing joinPolicy as invite, not open', () => {
		expect(parseGroupProfile({ displayName: 'Kona', joinPolicy: 'everyone' })?.joinPolicy).toBe(
			'invite'
		);
		expect(parseGroupProfile({ displayName: 'Kona' })?.joinPolicy).toBe('invite');
	});

	// A page must still render for a record an older build wrote, so tolerance
	// is the contract — but a record with no name is not a profile.
	it('rejects a value with no usable displayName', () => {
		expect(parseGroupProfile({ displayName: '   ' })).toBeNull();
		expect(parseGroupProfile({ description: 'no name here' })).toBeNull();
		expect(parseGroupProfile(null)).toBeNull();
		expect(parseGroupProfile('Kona')).toBeNull();
	});

	it('survives a location that is not the shape we write', () => {
		expect(parseGroupProfile({ displayName: 'Kona', location: 'Kona' })?.locationName).toBeNull();
		expect(parseGroupProfile({ displayName: 'Kona', location: { name: 7 } })?.locationName).toBeNull();
	});
});

describe('rules', () => {
	it('round-trips text and the declared order extension', () => {
		const record = groupRuleRecord({ text: '  Be kind  ', order: 2 });
		expect(record.text).toBe('Be kind');
		expect(record.order).toBe(2);
		expect(parseGroupRule(record)).toMatchObject({ text: 'Be kind', order: 2 });
	});

	// A reader that does not know `order` gets an unordered set — that is what
	// the draft promises — so a record without it must still parse.
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
