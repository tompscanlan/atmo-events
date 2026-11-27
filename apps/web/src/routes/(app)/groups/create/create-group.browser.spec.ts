import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import '../../../../app.css';

const mocks = vi.hoisted(() => ({ requestPermissions: vi.fn(async () => {}) }));
vi.mock('@svelte-atproto/oauth/client', () => ({ requestPermissions: mocks.requestPermissions }));

import CreatePage from './+page.svelte';

const ALICE = 'did:plc:alice';

function data(
	access: 'ask' | 'refused' | null,
	unfinished: { did: string; handle: string }[] = []
) {
	return {
		pageTitle: 'Make a group',
		available: true,
		did: ALICE,
		host: { domain: '.groups.example', newGroupUrl: 'https://host.example/new' },
		access,
		unfinished
	};
}

const shown = () => (document.body.textContent ?? '').replace(/\s+/g, ' ');

afterEach(() => vi.clearAllMocks());

describe('the make-a-group page', () => {
	it('offers the form, with the address ending in the host’s domain', async () => {
		render(CreatePage, { data: data(null) as never, form: null as never });
		await expect.element(page.getByLabelText('Name')).toBeVisible();
		await expect.element(page.getByLabelText('Address')).toBeVisible();
		expect(shown()).toContain('.groups.example');
		await expect.element(page.getByRole('button', { name: 'Make the group' })).toBeVisible();
	});

	it('asks for the permission first, instead of the form', async () => {
		render(CreatePage, { data: data('ask') as never, form: null as never });
		await page.getByRole('button', { name: 'Allow making groups' }).click();
		await expect.poll(() => mocks.requestPermissions).toHaveBeenCalled();
		expect(mocks.requestPermissions).toHaveBeenCalledWith(
			['rpc:org.atgrp.internal.createGroup?aud=*', 'rpc:org.atgrp.internal.getActorGroups?aud=*'],
			// Back to this page, marked as asked by this person.
			{ returnTo: expect.stringContaining(`asked=${encodeURIComponent(ALICE)}`) }
		);
		expect(page.getByRole('button', { name: 'Make the group' }).elements()).toHaveLength(0);
	});

	it("points at the host's own page when the person's server said no", async () => {
		render(CreatePage, { data: data('refused') as never, form: null as never });
		await expect
			.element(page.getByRole('link', { name: 'Make a group there' }))
			.toHaveAttribute('href', 'https://host.example/new');
	});

	it('keeps what was typed when the host refused it, and says why', async () => {
		render(CreatePage, {
			data: data(null) as never,
			form: {
				values: {
					name: 'Night Riders',
					address: 'riders',
					description: '',
					joinPolicy: 'open',
					public: true
				},
				reason: 'address-taken',
				message: 'That address is taken. Try another.'
			} as never
		});
		await expect
			.element(page.getByRole('alert'))
			.toHaveTextContent('That address is taken. Try another.');
		await expect.element(page.getByLabelText('Name')).toHaveValue('Night Riders');
		await expect.element(page.getByLabelText('Address')).toHaveValue('riders');
	});

	it('offers to finish a group the person made a moment ago, when the address was theirs', async () => {
		render(CreatePage, {
			data: data(null) as never,
			form: {
				values: {
					name: 'Night Riders',
					address: 'riders',
					description: '',
					joinPolicy: 'open',
					public: true
				},
				reason: 'made-already',
				message: "You made this group already, but setting it up here didn't finish.",
				made: { did: 'did:plc:riders', handle: 'riders.groups.example' }
			} as never
		});
		const finish = page.getByRole('button', { name: 'Finish setting up' });
		await expect.element(finish).toBeVisible();
		const form = finish.element().closest('form');
		expect(form?.getAttribute('action')).toBe('/oauth/group/link');
		expect(new FormData(form as HTMLFormElement).get('group')).toBe('did:plc:riders');
	});

	it('takes the form once: the button is off while it is sent', async () => {
		render(CreatePage, { data: data(null) as never, form: null as never });
		const make = page.getByRole('button', { name: 'Make the group' });
		await expect.element(make).toBeEnabled();
		const form = make.element().closest('form') as HTMLFormElement;
		// Sent, but kept on this page, as a slow answer would keep it.
		form.addEventListener('submit', (event) => event.preventDefault());
		await page.getByLabelText('Name').fill('Night Riders');
		await page.getByLabelText('Address').fill('riders');
		await make.click();
		await expect.element(make).toBeDisabled();
	});

	it('offers to finish a group made here but not linked yet', async () => {
		render(CreatePage, {
			data: data(null, [{ did: 'did:plc:riders', handle: 'riders.groups.example' }]) as never,
			form: null as never
		});
		const finish = page.getByRole('button', { name: 'Finish setting up' });
		await expect.element(finish).toBeVisible();
		const form = finish.element().closest('form');
		expect(form?.getAttribute('action')).toBe('/oauth/group/link');
		expect(new FormData(form as HTMLFormElement).get('group')).toBe('did:plc:riders');
	});
});
