// What a form says when the caller lacks a permission, or the group cannot be
// written as.
import { describe, it, expect } from 'vitest';
import { formError, notAllowed, rosterFailure } from './form-error';

import { GroupCredentialError } from './server/session';
import { RosterStepError, type RosterChange } from './server/roster';
import { GroupSpaceError } from './server/spaces';
describe('notAllowed', () => {
	it('names the permission when the caller simply lacks it', () => {
		expect(notAllowed({}, 'MANAGE_GROUP')).toEqual({
			ok: false,
			error: 'Not allowed: MANAGE_GROUP required'
		});
	});

	// The members space did not answer, so the gate granted nothing. The caller
	// may well hold the permission; the message must not claim they do not.
	it('says the permissions could not be checked when the members space was unreadable', () => {
		const refusal = notAllowed(
			{ unreadable: 'com.atproto.space.getRecord failed: 400 SpaceNotFound' },
			'MANAGE_GROUP'
		);
		expect(refusal.ok).toBe(false);
		expect(refusal.error).not.toMatch(/Not allowed/);
		expect(refusal.error).toMatch(/could not be checked/);
		expect(refusal.error).toContain('400 SpaceNotFound');
	});
});

describe('formError', () => {
	// A group nobody has linked refuses every write as the group. The way out
	// is the owner's link step, so the message names it, and says that nothing
	// was half-done.
	it('tells the caller the owner has to link the group’s account', () => {
		const refusal = formError(new GroupCredentialError('did:plc:unlinkedgroupaaaaaaaaaaa'));

		expect(refusal.ok).toBe(false);
		expect(refusal.error).toMatch(/owner has to link the group’s account/);
		expect(refusal.error).toMatch(/Nothing was changed/);
	});

	// A failure it does not know, such as a database that went down partway, is
	// not the caller's to fix, and as a form message it would read as a refusal
	// and hide the 500. It goes back up as it came.
	it.each([
		['an Error', new Error('D1_ERROR: database is locked')],
		['a thrown value that is no Error', { status: 500 }]
	])('rethrows %s it does not know, unchanged', (_, failure) => {
		let thrown: unknown;
		try {
			formError(failure);
		} catch (e) {
			thrown = e;
		}
		expect(thrown).toBe(failure);
	});
});

// A roster act runs in halves, and a later half can fail after an earlier one
// took effect. The member is told which half landed, with the failure's own
// text, so the message says what is out of step. Each case checks the half and
// the text, not the sentence around them.
describe('rosterFailure', () => {
	const SUBJECT = 'did:plc:subjectaaaaaaaaaaaaaaaaa';
	const CAUSE = 'com.atproto.simplespace.putMember failed: 500';
	const failed = (step: 'list' | 'record' | 'row', change?: RosterChange) =>
		rosterFailure(new RosterStepError(step, SUBJECT, new Error(CAUSE), change));

	// The member lists at the host disagree with the record, and how depends on
	// the act: a grant is on the roster but not listed, a request was sent but
	// not recorded at the host, and a revocation took read access away but left
	// the membership.
	it.each([
		['grant', /is on the roster/],
		['request', /request to join was sent/],
		['revoke', /can no longer read the group/]
	] as const)('a %s whose member-list step failed says what took effect', (change, landed) => {
		const failure = failed('list', change);
		expect(failure.ok).toBe(false);
		expect(failure.error).toMatch(landed);
		expect(failure.error).toContain(CAUSE);
	});

	it('a grant whose record step failed says the roster changed and names who', () => {
		const failure = failed('record', 'grant');
		expect(failure.error).toMatch(/roster was updated/);
		expect(failure.error).toContain(SUBJECT);
		expect(failure.error).toContain(CAUSE);
	});

	// Any other step: a revocation whose record went and whose row did not.
	it('a revocation whose row step failed says access was revoked', () => {
		const failure = failed('row', 'revoke');
		expect(failure.error).toMatch(/Access was revoked/);
		expect(failure.error).toContain(CAUSE);
	});

	// The first write of a revocation was refused, so nothing took effect.
	it('a refused member-list removal says nothing was changed', () => {
		const failure = rosterFailure(
			new GroupSpaceError('removeMember failed: 502', 'group.opensocial.members')
		);
		expect(failure.error).toMatch(/nothing was changed/);
		expect(failure.error).toContain('removeMember failed: 502');
	});

	// Anything else goes through formError, which rethrows what it does not know.
	it('rethrows a failure it does not know, unchanged', () => {
		const failure = new Error('D1_ERROR: database is locked');
		let thrown: unknown;
		try {
			rosterFailure(failure);
		} catch (e) {
			thrown = e;
		}
		expect(thrown).toBe(failure);
	});
});
