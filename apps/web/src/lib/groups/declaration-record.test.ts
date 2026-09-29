import { describe, it, expect } from 'vitest';
import { declarationRequired } from './declaration-record';

describe('declarationRequired', () => {
	// The caller passes the visibility it has: the form's choice on a create or a
	// save, the host's read policy on a repair. There is no row to read it from.
	it('whether to declare is decided from the visibility choice', () => {
		expect(declarationRequired('public')).toBe(true);
		expect(declarationRequired('private')).toBe(false);
		expect(declarationRequired.length).toBe(1);
	});
});
