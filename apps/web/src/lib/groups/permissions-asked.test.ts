import { describe, expect, it } from 'vitest';
import { ASKED_COOKIE, groupAccess } from './permissions-asked';

const cookies = (value?: string) => ({
	get: (name: string) => (name === ASKED_COOKIE ? value : undefined)
});

describe('groupAccess', () => {
	it('asks someone who has not asked from this browser, and explains once they have', () => {
		expect(groupAccess(true, cookies(), 'did:plc:carol')).toBe('ask');
		expect(groupAccess(true, cookies('did:plc:carol'), 'did:plc:carol')).toBe('refused');
	});

	it('does not count an ask made by someone else in the same browser', () => {
		expect(groupAccess(true, cookies('did:plc:bob'), 'did:plc:carol')).toBe('ask');
	});

	it('has nothing to say to someone who holds the permissions', () => {
		expect(groupAccess(false, cookies('did:plc:carol'), 'did:plc:carol')).toBeNull();
	});
});
