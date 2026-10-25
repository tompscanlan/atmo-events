import { describe, it, expect } from 'vitest';
import { formError, notAllowed } from './form-error';
import { GroupNotAtHostError } from './server/host';
import { GroupCredentialError } from './server/session';

describe('notAllowed', () => {
	it.each([
		['a sign-in without the groups grant', { signIn: true }, 'sign-in-required'],
		['no space access', { noSpaceAccess: true }, 'no-space-access'],
		['a members-space outage', { unreadable: 'host unavailable' }, 'members-unreadable'],
		['an ordinary denial', {}, 'permission-denied'],
		[
			'a sign-in that also reads no spaces',
			{ signIn: true, noSpaceAccess: true },
			'sign-in-required'
		]
	] as const)('names %s by its reason', (_, membership, reason) => {
		expect(notAllowed(membership, 'MANAGE_GROUP')).toMatchObject({ ok: false, reason });
	});
});

describe('formError', () => {
	it.each([
		['no group session', new GroupCredentialError('did:plc:group', 'did:plc:caller')],
		['a group at another host', new GroupNotAtHostError('did:plc:group')]
	])('turns %s into a refusal', (_, e) => {
		expect(formError(e).ok).toBe(false);
	});

	it.each([
		['an Error', new Error('D1_ERROR: database is locked')],
		['a thrown value that is no Error', { status: 500 }]
	])('rethrows %s it does not know, unchanged', (_, failure) => {
		expect(() => formError(failure)).toThrow();
		try {
			formError(failure);
		} catch (e) {
			expect(e).toBe(failure);
		}
	});
});
