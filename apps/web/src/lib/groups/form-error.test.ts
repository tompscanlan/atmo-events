// What a form says when the caller lacks a permission, or the group cannot be
// written as.
import { describe, it, expect } from 'vitest';
import { formError, notAllowed } from './form-error';

import { GroupNotAtHostError } from './server/host';
import { GroupCredentialError } from './server/session';
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

	// A group at no host this site is set up with cannot be changed from here,
	// and nothing the caller does on this site changes that.
	it('says a group not at this site’s host cannot be changed here', () => {
		const refusal = formError(new GroupNotAtHostError('did:plc:elsewheregroupaaaaaaaaaa'));

		expect(refusal.ok).toBe(false);
		expect(refusal.error).toMatch(/not at this site’s group host/);
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
