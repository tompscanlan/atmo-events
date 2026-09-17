import { describe, expect, it } from 'vitest';
import {
	GROUP_SLUG_PATTERN,
	slugMintRefusal,
	slugifyGroupName,
	type SlugMintRefusal
} from './slug';

describe('slugifyGroupName', () => {
	it('derives the slug a group is addressed by', () => {
		expect(slugifyGroupName('Kona Trail Runners Club')).toBe('kona-trail-runners-club');
	});

	// The mint rules refuse this name; the derivation must still hand back what
	// the user asked for, so the form can say WHICH name is too long instead of
	// silently addressing the group as something else.
	it('never truncates, however long the name', () => {
		const slug = slugifyGroupName('a'.repeat(60));
		expect(slug).toHaveLength(60);
	});

	it('returns empty rather than inventing a label when nothing survives', () => {
		expect(slugifyGroupName('日本語のグループ')).toBe('');
		expect(slugifyGroupName('!!!')).toBe('');
	});
});

describe('slugMintRefusal', () => {
	it('accepts a label the PDS accepts', () => {
		expect(slugMintRefusal('kona-trail')).toBeNull();
		expect(slugMintRefusal('abc')).toBeNull();
		expect(slugMintRefusal('a'.repeat(18))).toBeNull();
	});

	// 3 and 18 are the PDS's own bounds (ensureHandleServiceConstraints); off by
	// one either way is a mint that fails after the user pressed create.
	it.each([
		['ab', 'too-short'],
		['a'.repeat(19), 'too-long'],
		// The ordinary case, not an edge: this is what a real club name slugifies to.
		['kona-trail-runners-club', 'too-long']
	] as [string, SlugMintRefusal][])('refuses %s as %s', (slug, expected) => {
		expect(slugMintRefusal(slug)).toBe(expected);
	});

	it('refuses labels the protocol reserves', () => {
		expect(slugMintRefusal('pds')).toBe('reserved');
		expect(slugMintRefusal('xrpc')).toBe('reserved');
	});

	// `about` and `members` are a group's own space names; `about` is in the PDS's
	// commonlyReserved list too, so this refusal matches what minting would do.
	it('refuses our own space names', () => {
		expect(slugMintRefusal('about')).toBe('reserved');
		expect(slugMintRefusal('members')).toBe('reserved');
	});

	it('refuses anything with a dot, which would add a handle label', () => {
		expect(slugMintRefusal('kona.trail')).toBe('characters');
	});

	it('reports characters before length, as the PDS does', () => {
		expect(slugMintRefusal('a.b')).toBe('characters');
	});

	it('refuses the empty slug slugifyGroupName returns for an unusable name', () => {
		expect(slugMintRefusal('')).toBe('characters');
	});
});

describe('GROUP_SLUG_PATTERN', () => {
	// Deliberately WIDER than the mint rules: groups.slug has no length limit in
	// D1 and legacy imports bring long slugs, so every form that addresses an
	// EXISTING group must keep accepting them. Narrowing this pattern to the mint
	// bounds would stop a member leaving a group that already exists.
	it('still accepts slugs longer than a mintable label', () => {
		expect(GROUP_SLUG_PATTERN.test('kona-trail-runners-club')).toBe(true);
		expect(GROUP_SLUG_PATTERN.test('a'.repeat(48))).toBe(true);
	});
});
