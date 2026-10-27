import { describe, it, expect } from 'vitest';
import * as v from 'valibot';
import { GROUP_RULE_MAX } from './about-record';
import {
	checkboxField,
	groupRulesField,
	groupSettingsFields,
	memberActorField,
	shownVisibilityField
} from './form-fields';

// Through `v.object`: the bug is in how an object schema treats a missing optional key.
describe('checkboxField', () => {
	const form = v.object({ listed: checkboxField });

	it('reads a missing key as false and a ticked box as true', () => {
		expect(v.parse(form, {}).listed).toBe(false);
		expect(v.parse(form, { listed: 'on' }).listed).toBe(true);
	});
});

describe('shownVisibilityField', () => {
	const settings = v.object({ shownVisibility: shownVisibilityField });

	it.each([{}, { shownVisibility: '' }])('reads %j as unknown', (input) => {
		expect(v.parse(settings, input).shownVisibility).toBeUndefined();
	});

	it('refuses a value that is not a visibility', () => {
		expect(v.safeParse(settings, { shownVisibility: 'unlisted' }).success).toBe(false);
	});
});

/** One grapheme, 25 bytes. */
const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}';

describe('groupSettingsFields', () => {
	const settings = v.object({ ...groupSettingsFields, rules: groupRulesField });
	const valid = { name: 'Kona', visibility: 'public', joinPolicy: 'approval' };
	const parses = (input: Record<string, unknown>) =>
		v.safeParse(settings, { ...valid, ...input }).success;

	it('takes a group within the lexicon’s bounds, unlisted when the box is unticked', () => {
		const parsed = v.parse(settings, valid);
		expect(parsed).toMatchObject({ name: 'Kona', joinPolicy: 'approval', listed: false });
	});

	it.each([
		['a blank name', { name: '   ' }],
		['a name over 64 graphemes', { name: 'x'.repeat(65) }],
		['a description over 2000 graphemes', { description: 'x'.repeat(2001) }],
		['an unknown join policy', { joinPolicy: 'anyone' }],
		['a rule line over the bound', { rules: `Be kind\n${'x'.repeat(GROUP_RULE_MAX + 1)}` }],
		['a one-grapheme name over 640 bytes', { name: `e${'\u0301'.repeat(400)}` }],
		['a description over 20000 bytes', { description: FAMILY.repeat(801) }],
		['a rule line over 20000 bytes', { rules: `Be kind\n${FAMILY.repeat(801)}` }]
	])('refuses %s', (_, input) => {
		expect(parses(input)).toBe(false);
	});

	it('counts graphemes, so 64 emoji are a valid name', () => {
		expect(parses({ name: '\u{1F44D}\u{1F3FD}'.repeat(64) })).toBe(true);
	});
});

describe('memberActorField', () => {
	const addForm = v.object({ actor: memberActorField });

	it.each([
		['alice.bsky.social', { handle: 'alice.bsky.social' }],
		['  @Alice.Bsky.Social ', { handle: 'alice.bsky.social' }],
		['did:plc:jcwgw6fcnb5vyoid7nz7sl26', { did: 'did:plc:jcwgw6fcnb5vyoid7nz7sl26' }]
	])('reads %j', (actor, expected) => {
		expect(v.parse(addForm, { actor }).actor).toEqual(expected);
	});

	it.each(['alice', '', 'did:plc'])('refuses %j before any lookup', (actor) => {
		expect(v.safeParse(addForm, { actor }).success).toBe(false);
	});
});
