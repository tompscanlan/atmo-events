import { describe, expect, it, vi } from 'vitest';
import { getProfileBlobUrl } from '#lib/contrail.js';

vi.mock('$app/env/public', async () => {
	const { variables } = await import('../../env');
	return {
		...Object.fromEntries(Object.keys(variables).map((name) => [name, undefined])),
		PUBLIC_CDN_URL: 'https://cdn.test'
	};
});

describe('profile image links', () => {
	it('use the image CDN a setting names', () => {
		expect(getProfileBlobUrl('did:plc:alice', { ref: { $link: 'avatar-cid' } })).toBe(
			'https://cdn.test/img/feed_thumbnail/plain/did:plc:alice/avatar-cid@webp'
		);
	});

	it('read the blob’s CID from either record shape', () => {
		expect(getProfileBlobUrl('did:plc:alice', { cid: 'old-cid' })).toBe(
			'https://cdn.test/img/feed_thumbnail/plain/did:plc:alice/old-cid@webp'
		);
		expect(getProfileBlobUrl('did:plc:alice', {})).toBeUndefined();
	});
});
