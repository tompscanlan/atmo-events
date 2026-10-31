import { describe, expect, it, vi } from 'vitest';
import { getBlueskyProfile } from './bluesky-profile';
import { variables } from '../../env';

const did = 'did:plc:alice';

describe('optional Bluesky profile hydration', () => {
	it('requests only the public AppView by default and returns validated modern link data', async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			Response.json({
				did,
				pronouns: 'they/them',
				followersCount: 123,
				website: 'https://legacy.test',
				links: [
					{ url: 'https://work.test', title: 'Work', icon: 'https://cdn.bsky.app/icon.webp' },
					{ url: 'javascript:evil' }
				]
			})
		);
		expect(await getBlueskyProfile(did, fetcher)).toMatchObject({
			did,
			pronouns: 'they/them',
			links: [{ url: 'https://work.test/', title: 'Work', icon: 'https://cdn.bsky.app/icon.webp' }]
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
		const [url, options] = fetcher.mock.calls[0];
		expect(String(url)).toBe(
			`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`
		);
		expect(options).toMatchObject({ redirect: 'error', credentials: 'omit' });
	});

	it('ignores failures, malformed data and mismatched accounts', async () => {
		for (const response of [
			new Response('', { status: 503 }),
			Response.json(null),
			Response.json({ did: 'did:plc:other' })
		]) {
			expect(
				await getBlueskyProfile(did, vi.fn<typeof fetch>().mockResolvedValue(response))
			).toBeUndefined();
		}
		expect(
			await getBlueskyProfile(did, vi.fn<typeof fetch>().mockRejectedValue(new Error('timeout')))
		).toBeUndefined();
	});

	it('asks the Bluesky API a setting names instead', async () => {
		vi.resetModules();
		const unset = Object.fromEntries(Object.keys(variables).map((name) => [name, undefined]));
		vi.doMock('$app/env/public', () => ({ ...unset, PUBLIC_APPVIEW_URL: 'https://appview.test' }));
		try {
			const { getBlueskyProfile } = await import('./bluesky-profile');
			const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 }));
			await getBlueskyProfile(did, fetcher);
			expect(String(fetcher.mock.calls[0][0])).toBe(
				`https://appview.test/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`
			);
		} finally {
			vi.doUnmock('$app/env/public');
			vi.resetModules();
		}
	});
});
