// What a form says when the caller lacks a permission.
import { describe, it, expect } from 'vitest';
import { notAllowed } from './form-error';

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
