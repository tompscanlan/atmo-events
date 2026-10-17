// What a form says when the caller lacks a permission, or the group cannot be
// written as.
import { describe, it, expect } from 'vitest';
import { formError, notAllowed, rosterFailure } from './form-error';

import { GroupCredentialError } from './server/session';
import { RosterStepError, type RosterChange } from './server/roster';
import { GroupSpaceError } from './server/spaces';
describe('notAllowed', () => {
	it.each([
		['missing group grant', { signIn: { from: null } }, 'sign-in-required'],
		['no space access', { noSpaceAccess: true }, 'no-space-access'],
		['members-space outage', { unreadable: 'host unavailable' }, 'members-unreadable'],
		['ordinary denial', {}, 'permission-denied'],
		// A missing group grant can also leave the caller with no space access.
		[
			'missing grant takes precedence',
			{ signIn: { from: 123 }, noSpaceAccess: true },
			'sign-in-required'
		]
	] as const)('identifies %s without depending on message wording', (_, membership, reason) => {
		expect(notAllowed(membership, 'MANAGE_GROUP')).toMatchObject({ ok: false, reason });
	});
});

describe('formError', () => {
	// A caller with no group session of their own is refused every write as the
	// group. The way out is their own link step, so the message names it, and
	// says that nothing was half-done.
	it('tells the caller to link their own access', () => {
		const refusal = formError(
			new GroupCredentialError(
				'did:plc:unlinkedgroupaaaaaaaaaaa',
				'did:plc:calleraaaaaaaaaaaaaaaaaaa'
			)
		);

		expect(refusal.ok).toBe(false);
		expect(refusal.error).toMatch(/link your access/);
		expect(refusal.error).toMatch(/Nothing was changed/);
	});

	// The stand-in host's session is the creator's, which only they can fix.
	it('names the creator when the stand-in host’s session is missing', () => {
		const refusal = formError(
			new GroupCredentialError(
				'did:plc:unlinkedgroupaaaaaaaaaaa',
				'did:plc:creatoraaaaaaaaaaaaaaaaaa',
				true
			)
		);

		expect(refusal.error).toMatch(/its creator has to link their access/);
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
	// the act: a grant is on the roster but not listed, and a revocation closed
	// atmo's gate but did not finish at the host.
	it.each([
		['grant', /is on the roster/],
		['revoke', /no longer has access here/]
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

	// The first write of a withdrawal or a rejection was refused, so nothing
	// took effect.
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
