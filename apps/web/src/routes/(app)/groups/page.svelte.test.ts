import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import GroupsPage from './+page.svelte';

const upcoming = {
	did: 'did:plc:g',
	name: 'Knitters',
	handle: 'knit.example',
	next: { title: 'Purl night', startsAt: '2030-01-02T12:00:00.000Z' }
};

function page(data: Record<string, unknown>) {
	return render(GroupsPage, {
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
				server: null,
				q: null,
				upcoming: [upcoming],
				servers: [],
				groups: [],
				linked: [],
				cursor: null,
				unavailable: false,
				canLink: false,
				signedIn: false,
				notice: null,
				...data
			} as never
		}
	}).body;
}

function links(data: Record<string, unknown>) {
	return [...page(data).matchAll(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map(
		([, href, text]) => ({
			url: new URL(href.replace(/&amp;/g, '&'), 'https://atmo.test'),
			text: text.replace(/<[^>]+>|\s+/g, ' ').trim()
		})
	);
}

const text = (html: string) => html.replace(/<[^>]+>|\s+/g, ' ').replace(/\s+/g, ' ');

describe('the groups list', () => {
	it("shows each group with an event coming by its next event's title and date", () => {
		const row = links({}).find((link) => link.url.pathname === '/groups/did:plc:g');
		expect(row?.text).toContain('Knitters');
		expect(row?.text).toContain('Purl night');
		expect(row?.text).toMatch(/Wed, Jan 2/);
	});

	it('counts each server’s groups and links it to its own page', () => {
		const servers = [
			{ server: 'https://pds.example:8443', host: 'pds.example:8443', groups: 4, upcoming: 1 }
		];
		expect(text(page({ servers }))).toContain('pds.example:8443 4 groups, 1 with events coming up');
		const all = links({ servers }).find((link) => link.text.startsWith('See all'));
		expect(all?.url.pathname).toBe('/groups');
		expect([...(all?.url.searchParams ?? [])]).toEqual([['server', 'https://pds.example:8443']]);
	});

	it('shows the groups the person has linked, above the list', () => {
		const linked = [
			{ did: 'did:plc:mine', name: 'Mine', handle: 'mine.example', description: null }
		];
		const html = text(page({ linked }));
		expect(html).toContain("Groups you've linked");
		expect(html.indexOf('Mine')).toBeLessThan(html.indexOf('Groups with events coming up'));
		expect(links({ linked }).some((link) => link.url.pathname === '/groups/did:plc:mine')).toBe(
			true
		);
		expect(text(page({}))).not.toContain("Groups you've linked");
	});

	it('pages the whole list without a server', () => {
		const next = links({ cursor: 'c2' }).find((link) => link.text.startsWith('More groups'));
		expect([...(next?.url.searchParams ?? [])]).toEqual([['cursor', 'c2']]);
	});
});

describe("a server's list, or a search's", () => {
	const server = { origin: 'https://pds.example', host: 'pds.example' };
	const found = [{ did: 'did:plc:f', name: 'Found', handle: 'f.example', description: 'About' }];

	it('searches only that server, and keeps the server and the search when it pages', () => {
		const html = page({ server, q: 'knit', groups: found, upcoming: [], cursor: 'c2' });
		expect(html).toMatch(/<input type="hidden" name="server" value="https:\/\/pds\.example"/);
		expect(html).toMatch(/name="q"[^>]*value="knit"|value="knit"[^>]*name="q"/);
		const next = links({ server, q: 'knit', groups: found, cursor: 'c2' }).find((link) =>
			link.text.startsWith('More groups')
		);
		expect([...(next?.url.searchParams ?? [])]).toEqual([
			['server', 'https://pds.example'],
			['q', 'knit'],
			['cursor', 'c2']
		]);
	});

	it('lists what was found, not the groups with an event coming', () => {
		const html = text(page({ q: 'knit', groups: found, upcoming: [upcoming] }));
		expect(html).toContain('Groups matching “knit”');
		expect(html).toContain('Found');
		expect(html).not.toContain('Purl night');
		expect(text(page({ q: 'knit', groups: [] }))).toContain('No group matches that.');
	});
});

describe('making a group', () => {
	const signedIn = { canLink: true, signedIn: true, you: 'did:plc:alice' };
	const WHAT_A_GROUP_IS =
		"A group is a community with its own page that others can find and ask to join, where members whose role allows it post as the group. Group events are made from the group's page, as the group.";

	it("opens the group host's own page for it, in a new tab, and says to link the group after", () => {
		const html = page({ ...signedIn, newGroupUrl: 'https://host.example/new' });
		const make = html.match(/<a[^>]*href="https:\/\/host\.example\/new"[^>]*>([\s\S]*?)<\/a>/);
		expect(make?.[0]).toContain('target="_blank"');
		expect(make?.[0]).toContain('rel="noopener noreferrer"');
		expect(text(make?.[1] ?? '')).toContain('Make a group');
		expect(text(html)).toContain('Make the group at the group host, then link it here.');
		expect(text(html)).toContain(WHAT_A_GROUP_IS);
		expect(html).toContain('Link a group you help run');
	});
});
