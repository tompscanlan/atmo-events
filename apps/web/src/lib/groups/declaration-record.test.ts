import { describe, it, expect } from 'vitest';
import { declarationRequired, groupDeclarationRecord } from './declaration-record';

const META = 'at://did:plc:group/space/group.opensocial.meta/self';

describe('declarationRequired', () => {
	// The caller passes the visibility it has: the form's choice on a create or a
	// save, the host's read policy on a repair. There is no row to read it from.
	it('whether to declare is decided from the visibility choice', () => {
		expect(declarationRequired('public')).toBe(true);
		expect(declarationRequired('private')).toBe(false);
	});
});

describe('groupDeclarationRecord', () => {
	it('points at the meta space and nothing else a stranger could render', () => {
		const record = groupDeclarationRecord({
			aboutSpaceUri: META,
			createdAt: '2026-01-02T03:04:05.000Z'
		});
		expect(record).toEqual({ meta: META, createdAt: '2026-01-02T03:04:05.000Z' });
	});
});
