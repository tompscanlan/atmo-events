import { describe, expect, it } from 'vitest';
import { ABOUT_SPACE_TYPE, MEMBERS_SPACE_TYPE } from '../types';
import { holdsMetaRead, readsMembersSpace } from './member-grants';

const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const BASE_SCOPE = 'atproto rpc:app.bsky.actor.getProfile?aud=*';

describe('readsMembersSpace', () => {
	it('takes a read of the members space for any group, or for this one', () => {
		const any = `${BASE_SCOPE} space:${MEMBERS_SPACE_TYPE}?authority=*&action=read`;
		expect(readsMembersSpace(any, GROUP_DID)).toBe(true);
		const one = `${BASE_SCOPE} space:*?authority=${GROUP_DID}&action=read`;
		expect(readsMembersSpace(one, GROUP_DID)).toBe(true);
		expect(readsMembersSpace(one, 'did:plc:other')).toBe(false);
	});

	// The spaces PDS drops every parameter left at its default when it hands a grant back.
	it('reads a grant as the PDS writes it, defaults dropped', () => {
		const participate = `${BASE_SCOPE} space:${MEMBERS_SPACE_TYPE}?authority=*&skey=self&collection=group.opensocial.acceptance`;
		expect(readsMembersSpace(participate, GROUP_DID)).toBe(true);
		// No authority: the signer's own repo, never a group's.
		expect(readsMembersSpace(`space:${MEMBERS_SPACE_TYPE}`, GROUP_DID)).toBe(false);
	});

	it('needs the read action when the grant names its actions', () => {
		const writeOnly = `space:${MEMBERS_SPACE_TYPE}?authority=*&action=create&action=delete`;
		expect(readsMembersSpace(writeOnly, GROUP_DID)).toBe(false);
	});

	it('ignores a grant for another space type', () => {
		expect(readsMembersSpace(`space:${ABOUT_SPACE_TYPE}?authority=*`, GROUP_DID)).toBe(false);
	});
});

describe('holdsMetaRead', () => {
	it('takes a read of every group’s meta space, with or without its action', () => {
		expect(holdsMetaRead(`space:${ABOUT_SPACE_TYPE}?authority=*&action=read`)).toBe(true);
		expect(holdsMetaRead(`space:${ABOUT_SPACE_TYPE}?authority=*`)).toBe(true);
	});

	it('needs every group, not one', () => {
		expect(holdsMetaRead(`space:${ABOUT_SPACE_TYPE}?authority=${GROUP_DID}`)).toBe(false);
		expect(holdsMetaRead(BASE_SCOPE)).toBe(false);
	});
});
