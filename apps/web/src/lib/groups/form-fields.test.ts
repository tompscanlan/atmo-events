// The one thing `checkboxField` has to get right is the case an HTML form does
// not send: an unticked checkbox contributes NO FormData entry at all. Parsing
// that as `undefined` rather than `false` is not a type nicety — both group
// forms branch on it, in opposite directions, and the result is a group that
// says one thing and does another (see ./form-fields.ts for the 2026-09-22
// walkthrough finding this defends).
//
// Asserted through `v.object`, never on the field alone: the defect lived in
// how the OBJECT schema treats an optional entry, so parsing the bare field
// would have passed while the form still broke.
import { describe, it, expect } from 'vitest';
import * as v from 'valibot';
import { checkboxField } from './form-fields';

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
