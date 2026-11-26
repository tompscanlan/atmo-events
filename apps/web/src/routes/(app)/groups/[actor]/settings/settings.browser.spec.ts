import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { error } from '@sveltejs/kit';
import '../../../../../app.css';

const mocks = vi.hoisted(() => ({ saveGroupSettings: vi.fn() }));
// The save is a SvelteKit remote command, which a browser test has no server for.
vi.mock('#lib/groups/group.remote.js', () => mocks);

import SettingsPage from './+page.svelte';

const GROUP = 'did:plc:group';
const SETTINGS = {
	name: 'Night Riders',
	description: 'We ride at night.',
	website: 'https://riders.example/',
	joinPolicy: 'approval',
	public: true,
	listed: true
};

const settingsPage = () => ({
	pageTitle: 'Settings - Night Riders',
	group: { did: GROUP, name: 'Night Riders' },
	reapprove: false,
	settings: SETTINGS
});

afterEach(() => vi.resetAllMocks());

describe("a group's settings page", () => {
	it('starts from the settings as they are, and saves what the form says', async () => {
		mocks.saveGroupSettings.mockResolvedValue({ ok: true });
		render(SettingsPage, { data: settingsPage() as never });
		await expect.element(page.getByLabelText('Name')).toHaveValue('Night Riders');
		await expect.element(page.getByLabelText('Website')).toHaveValue('https://riders.example/');
		await page.getByLabelText('Name').fill('Night Owls');
		await page.getByLabelText('Only its members').click();
		await page.getByRole('button', { name: 'Save' }).click();
		await expect.poll(() => mocks.saveGroupSettings).toHaveBeenCalled();
		expect(mocks.saveGroupSettings).toHaveBeenCalledWith({
			groupDid: GROUP,
			shownPublic: true,
			settings: {
				name: 'Night Owls',
				description: 'We ride at night.',
				website: 'https://riders.example/',
				joinPolicy: 'approval',
				public: false,
				listed: false
			}
		});
	});

	it('keeps a join policy atmo does not know, unless another is picked', async () => {
		mocks.saveGroupSettings.mockResolvedValue({ ok: true });
		render(SettingsPage, {
			data: { ...settingsPage(), settings: { ...SETTINGS, joinPolicy: null } } as never
		});
		await expect.element(page.getByLabelText('How people join')).toHaveValue('');
		expect(
			page.getByRole('option', { name: 'As it is now, set outside atmo' }).elements()
		).toHaveLength(1);
		await page.getByRole('button', { name: 'Save' }).click();
		await expect.poll(() => mocks.saveGroupSettings).toHaveBeenCalled();
		expect(mocks.saveGroupSettings.mock.calls[0][0].settings.joinPolicy).toBe('');
	});

	it('offers no such choice for a join policy atmo knows', async () => {
		render(SettingsPage, { data: settingsPage() as never });
		await expect.element(page.getByLabelText('How people join')).toHaveValue('approval');
		expect(
			page.getByRole('option', { name: 'As it is now, set outside atmo' }).elements()
		).toHaveLength(0);
	});

	it('shows the reason the server gives for a refusal', async () => {
		mocks.saveGroupSettings.mockImplementation(async () =>
			error(403, 'Your role in this group no longer allows that.')
		);
		render(SettingsPage, { data: settingsPage() as never });
		await page.getByRole('button', { name: 'Save' }).click();
		await expect
			.element(page.getByRole('alert'))
			.toHaveTextContent('Your role in this group no longer allows that.');
	});

	it('offers to approve the link again, rather than a form it could not save', async () => {
		render(SettingsPage, {
			data: {
				pageTitle: 'Settings',
				group: { did: GROUP, name: 'Night Riders' },
				reapprove: true
			} as never
		});
		await expect.element(page.getByRole('button', { name: 'Approve again' })).toBeVisible();
		expect(page.getByRole('button', { name: 'Save' }).elements()).toHaveLength(0);
	});
});
