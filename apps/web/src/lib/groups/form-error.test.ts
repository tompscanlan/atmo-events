// What a form says when the caller lacks a permission, or the group cannot be
// written as.
import { describe, it, expect } from 'vitest';
import { formError, notAllowed } from './form-error';
import { GroupCredentialError } from './server/event-writer';

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
});
