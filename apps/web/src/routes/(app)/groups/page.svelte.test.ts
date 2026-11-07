import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import GroupsPage from './+page.svelte';

const group = {
	did: 'did:plc:g',
	name: 'Knitters',
	handle: null,
	description: null,
	linked: false
};

function links(data: Record<string, unknown>) {
	const html = render(GroupsPage, {
		props: {
			data: {
				did: null,
				profile: null,
				preferredSocialClient: null,
				preferredClientLoadFailed: false,
				canPostToBluesky: false,
				isModerator: false,
				pageTitle: 'Groups',
				pageDescription: '',
				groups: [group],
				cursor: null,
				declaredUnavailable: false,
				server: null,
				crowded: [],
				canLink: false,
				signedIn: false,
				notice: null,
				...data
			} as never
		}
	}).body;
	return [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map(
		([, href, text]) => ({
			url: new URL(href.replace(/&amp;/g, '&'), 'https://atmo.test'),
			text: text.replace(/<[^>]+>|\s+/g, ' ').trim()
		})
	);
}

describe('the groups list', () => {
	it('links each crowded server to its own page', () => {
		const more = links({
			crowded: [{ server: 'https://pds.example:8443', host: 'pds.example:8443', more: 4 }]
		}).find((link) => link.text.startsWith('pds.example'));
		expect(more?.url.pathname).toBe('/groups');
		expect(more?.url.searchParams.get('server')).toBe('https://pds.example:8443');
	});

	it("keeps a server's page on that server when it pages", () => {
		const next = links({
			server: { origin: 'https://pds.example', host: 'pds.example' },
			cursor: 'c2'
		}).find((link) => link.text.startsWith('More groups'));
		expect([...(next?.url.searchParams ?? [])]).toEqual([
			['server', 'https://pds.example'],
			['cursor', 'c2']
		]);
	});

	it('pages the whole list without a server', () => {
		const next = links({ cursor: 'c2' }).find((link) => link.text.startsWith('More groups'));
		expect([...(next?.url.searchParams ?? [])]).toEqual([['cursor', 'c2']]);
	});
});
