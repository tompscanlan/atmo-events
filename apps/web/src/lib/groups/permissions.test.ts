import { describe, it, expect } from 'vitest';
import { primaryRole } from './permissions';

describe('primaryRole', () => {
	it.each([
		[['member', 'admin'], 'admin'],
		[['moderator', 'member'], 'member'],
		[['moderator'], 'moderator'],
		[[], null]
	])('of %j is %j: the strongest known role, else the first named', (roles, expected) => {
		expect(primaryRole(roles)).toBe(expected);
	});
});
