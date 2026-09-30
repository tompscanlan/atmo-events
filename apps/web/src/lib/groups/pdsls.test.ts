import { describe, expect, it } from 'vitest';
import { pdslsUrl } from './pdsls';
import { spaceRecordUri } from './server/about-read';

const GROUP = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const SPACE = `at://${GROUP}/space/group.opensocial.members/self`;

describe('pdslsUrl', () => {
	it('opens a bare DID as its repo', () => {
		expect(pdslsUrl(GROUP)).toBe(`https://pds.ls/at://${GROUP}`);
	});

	it('takes a record URI as the path, unchanged', () => {
		const uri = `at://${GROUP}/community.lexicon.calendar.event/3lwxyz`;
		expect(pdslsUrl(uri)).toBe(`https://pds.ls/${uri}`);
	});

	// pds.ls routes a space on `at://<authority>/space/<type>/<skey>` and a
	// record in it on the repo, collection and rkey after that: the same strings
	// the host names them by, so both pass through as they are.
	it('takes a space URI as the path, unchanged', () => {
		expect(pdslsUrl(SPACE)).toBe(`https://pds.ls/${SPACE}`);
	});

	it('takes a record in a space as the path, unchanged', () => {
		const uri = spaceRecordUri(SPACE, GROUP, 'group.opensocial.membership', 'did:plc:member');
		expect(pdslsUrl(uri)).toBe(
			`https://pds.ls/${SPACE}/${GROUP}/group.opensocial.membership/did:plc:member`
		);
	});
});
