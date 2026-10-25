import { describe, it, expect } from 'vitest';
import { groupDeclarationRecord } from './declaration-record';

describe('groupDeclarationRecord', () => {
	it('names the meta space and nothing else a stranger could render', () => {
		const meta = 'at://did:plc:group/space/group.opensocial.meta/self';
		expect(groupDeclarationRecord({ aboutSpaceUri: meta })).toEqual({ meta });
	});
});
