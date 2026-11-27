import { describe, expect, it } from 'vitest';
import { parseSpaceUri } from './uri';

const DID = 'did:plc:hosthosthosthosthosthost';

describe('a space URI', () => {
	it('gives the same parts in the at:space/ form and in the older at:// one', () => {
		const parts = { authority: DID, type: 'community.lexicon.calendar.collection', key: '3lzz' };
		expect(parseSpaceUri(`at:space/${DID}/community.lexicon.calendar.collection/3lzz`)).toEqual(
			parts
		);
		expect(parseSpaceUri(`at://${DID}/space/community.lexicon.calendar.collection/3lzz`)).toEqual(
			parts
		);
	});
});
