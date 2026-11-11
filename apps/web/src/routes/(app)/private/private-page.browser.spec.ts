import { describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import '../../../app.css';
import PrivatePage from './+page.svelte';

const base = {
	pageTitle: 'Private events',
	did: 'did:plc:person',
	spacesServer: null,
	access: null,
	incomplete: false,
	invitations: [],
	invitationsIncomplete: false,
	invitationScopes: null,
	invitationsOn: true,
	scopes: null
};
const event = {
	name: 'A party',
	startsAt: '2030-01-01T18:00:00Z',
	did: 'did:plc:host',
	rkey: '3kabc',
	uri: 'at://did:plc:host/community.lexicon.calendar.event/3kabc',
	createdAt: '2029-01-01T00:00:00Z',
	rsvpsCount: 0,
	rsvpsGoingCount: 0
};
const listed = [{ event, href: '/p/x/private/3kabc', hosting: true, hostHandle: null }];

describe('/private', () => {
	it('says how an invitation arrives when there is nothing to list', async () => {
		render(PrivatePage, { data: { ...base, events: [] } } as never);
		await expect.element(page.getByTestId('how-invitations-arrive')).toBeVisible();
		await expect.element(page.getByTestId('invitations')).not.toBeInTheDocument();
	});

	it('says it under a list too, since the host’s link works for someone with no inbox', async () => {
		render(PrivatePage, { data: { ...base, events: listed } } as never);
		await expect.element(page.getByTestId('private-events')).toBeVisible();
		await expect.element(page.getByTestId('how-invitations-arrive')).toBeVisible();
	});

	it('lists an invitation above the events, by who sent it, with the way to the event', async () => {
		const invitation = {
			space: 'at://did:plc:host/space/rsvp.atmo.dev.space/3kxyz',
			host: 'did:plc:host',
			hostHandle: 'host.example.com',
			invitedAt: '2026-11-10T12:00:00.000Z',
			href: '/p/host.example.com/private/3kxyz'
		};
		render(PrivatePage, { data: { ...base, events: listed, invitations: [invitation] } } as never);
		const invitations = page.getByTestId('invitations');
		await expect.element(invitations.getByText(/host\.example\.com invited you/)).toBeVisible();
		await expect
			.element(invitations.getByRole('link', { name: 'See it' }))
			.toHaveAttribute('href', '/p/host.example.com/private/3kxyz');
	});

	it('says invitations may be missing when the inbox could not be read, though none shows', async () => {
		render(PrivatePage, {
			data: { ...base, events: listed, invitationsIncomplete: true }
		} as never);
		await expect.element(page.getByTestId('invitations-incomplete')).toBeVisible();
	});

	it('tells someone from before invitations that the link is the invitation, and offers them', async () => {
		render(PrivatePage, {
			data: { ...base, events: listed, invitations: null, invitationScopes: ['space:x'] }
		} as never);
		await expect.element(page.getByTestId('link-is-invitation')).toBeVisible();
		await expect.element(page.getByRole('button', { name: 'Allow invitations' })).toBeVisible();
	});

	it('says the link is the invitation, and offers nothing, where invitations are off', async () => {
		render(PrivatePage, {
			data: { ...base, events: listed, invitations: null, invitationsOn: false }
		} as never);
		await expect.element(page.getByTestId('link-is-invitation')).toBeVisible();
		await expect
			.element(page.getByRole('button', { name: 'Allow invitations' }))
			.not.toBeInTheDocument();
	});
});
