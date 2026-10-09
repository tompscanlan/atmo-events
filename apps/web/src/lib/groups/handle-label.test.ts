import { describe, expect, it } from 'vitest';
import {
	GROUP_LABEL_PATTERN,
	labelMintRefusal,
	labelFromGroupName,
	type LabelMintRefusal
} from './handle-label';

describe('labelFromGroupName', () => {
	it('derives the handle label a group would mint under', () => {
		expect(labelFromGroupName('Kona Trail Runners Club')).toBe('kona-trail-runners-club');
	});

	// The mint rules refuse this name; the derivation must still hand back what
	// the user asked for, so the form can say WHICH name is too long instead of
	// silently addressing the group as something else.
	it('never truncates, however long the name', () => {
		const label = labelFromGroupName('a'.repeat(60));
		expect(label).toHaveLength(60);
	});

	// Nothing survives, so there is no label to invent, and the empty one is
	// refused rather than minted.
	it('returns empty rather than inventing a label, and that is refused', () => {
		expect(labelFromGroupName('日本語のグループ')).toBe('');
		expect(labelFromGroupName('!!!')).toBe('');
		expect(labelMintRefusal('')).toBe('characters');
	});
});

describe('labelMintRefusal', () => {
	// 3 and 18 are the PDS's own bounds (ensureHandleServiceConstraints); off by
	// one either way is a mint that fails after the user pressed create.
	it.each([
		['abc', null],
		['a'.repeat(18), null],
		['ab', 'too-short'],
		['a'.repeat(19), 'too-long'],
		// The ordinary case, not an edge: this is what a real club name derives to.
		['kona-trail-runners-club', 'too-long']
	] as [string, LabelMintRefusal | null][])('answers %s with %s', (label, expected) => {
		expect(labelMintRefusal(label)).toBe(expected);
	});

	// `about` and `members` are a group's own space names; `about` is in the PDS's
	// commonlyReserved list too, so this refusal matches what minting would do.
	it('refuses labels the protocol reserves, and our own space names', () => {
		for (const label of ['pds', 'xrpc', 'about', 'members']) {
			expect(labelMintRefusal(label), label).toBe('reserved');
		}
	});

	// A dot would add a handle label. Two characters long, so a length check
	// that ran first would answer too-short.
	it('reports characters before length, as the PDS does', () => {
		expect(labelMintRefusal('a.')).toBe('characters');
	});
});

describe('GROUP_LABEL_PATTERN', () => {
	// Deliberately wider than the mint rules: this is the shape check the create
	// form's label field runs, and a group may already hold a handle minted
	// before those bounds or imported with it. Narrowing it to the mint bounds
	// would refuse a label the PDS has already registered.
	it('still accepts labels longer than a mintable one', () => {
		expect(GROUP_LABEL_PATTERN.test('kona-trail-runners-club')).toBe(true);
		expect(GROUP_LABEL_PATTERN.test('a'.repeat(48))).toBe(true);
	});
});
