// The case `checkboxField` must get right is the one an HTML form does not
// send: an unticked checkbox adds no FormData entry at all. Both group forms
// branch on the parsed value, so `undefined` instead of `false` gives a group
// that says one thing and does another (see ./form-fields.ts).
//
// Tested through `v.object`, never on the field alone: the problem is in how
// the object schema treats an optional entry, so parsing the bare field would
// pass while the form still broke.
import { describe, it, expect } from 'vitest';
import * as v from 'valibot';
import { checkboxField, shownVisibilityField } from './form-fields';

const form = v.object({ requireApproval: checkboxField });

describe('checkboxField', () => {
	it('reads a missing key as false, not undefined', () => {
		const parsed = v.parse(form, {});
		expect(parsed.requireApproval).toBe(false);
	});

	it('reads a ticked box as true', () => {
		expect(v.parse(form, { requireApproval: 'on' }).requireApproval).toBe(true);
	});

	it('reads an empty string as false', () => {
		expect(v.parse(form, { requireApproval: '' }).requireApproval).toBe(false);
	});
});

// The settings form's hidden record of what it showed. A page that could not
// read the host sends it empty, and a page rendered before the field existed
// sends nothing; the save reads both as "shown unknown", so both must parse to
// `undefined` rather than to a visibility or an error.
describe('shownVisibilityField', () => {
	const settings = v.object({ shownVisibility: shownVisibilityField });

	it('reads a missing key as unknown', () => {
		expect(v.parse(settings, {}).shownVisibility).toBeUndefined();
	});

	it('reads an empty value as unknown', () => {
		expect(v.parse(settings, { shownVisibility: '' }).shownVisibility).toBeUndefined();
	});

	it('reads a visibility as itself', () => {
		expect(v.parse(settings, { shownVisibility: 'private' }).shownVisibility).toBe('private');
		expect(v.parse(settings, { shownVisibility: 'public' }).shownVisibility).toBe('public');
	});

	it('refuses a value that is not a visibility', () => {
		expect(() => v.parse(settings, { shownVisibility: 'unlisted' })).toThrow();
	});
});
