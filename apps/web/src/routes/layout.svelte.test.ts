import { describe, expect, it, vi } from 'vitest';
import { createRawSnippet } from 'svelte';
import { render } from 'svelte/server';
import { getCDNImageBlobUrl } from '@atmo-dev/events-ui';
import Layout from './+layout.svelte';

vi.mock('$app/state', () => ({ page: { status: 200, error: null, data: {} } }));
vi.mock('$app/env/public', async () => {
	const { variables } = await import('../env');
	return {
		...Object.fromEntries(Object.keys(variables).map((name) => [name, undefined])),
		PUBLIC_CDN_URL: 'https://cdn.test/'
	};
});

const blob = { $type: 'blob' as const, ref: { $link: 'image-cid' } };

describe('root layout', () => {
	it('points the shared components at the image CDN a setting names', () => {
		const image = () => getCDNImageBlobUrl({ did: 'did:plc:alice', blob });
		expect(image()).toBe(
			'https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:alice/image-cid@webp'
		);

		// render() is lazy: the layout runs when its body is read.
		const { body } = render(Layout, {
			props: { children: createRawSnippet(() => ({ render: () => '<main></main>' })) }
		});
		expect(body).toContain('<main></main>');

		expect(image()).toBe('https://cdn.test/img/feed_thumbnail/plain/did:plc:alice/image-cid@webp');
	});
});
