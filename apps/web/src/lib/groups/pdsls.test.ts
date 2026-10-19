import { describe, expect, it } from 'vitest';
import { pdslsUrl } from './pdsls';

describe('pdslsUrl', () => {
	it('opens an at:// URI, or a bare DID as its repo, in the given record browser', () => {
		expect(pdslsUrl('at://did:plc:abc/app.x/1', 'https://pds.ls')).toBe(
			'https://pds.ls/at://did:plc:abc/app.x/1'
		);
		expect(pdslsUrl('did:plc:abc', 'https://pdsls.lighthouse.snowglobe.at')).toBe(
			'https://pdsls.lighthouse.snowglobe.at/at://did:plc:abc'
		);
	});

	it('is null when the network has no record browser', () => {
		expect(pdslsUrl('did:plc:abc', null)).toBeNull();
	});
});
