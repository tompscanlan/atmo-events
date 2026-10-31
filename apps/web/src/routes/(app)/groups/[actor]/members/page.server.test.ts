import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	groupView: vi.fn(),
	callerSession: vi.fn(),
	readRoster: vi.fn()
}));
vi.mock('#lib/groups/server/context.js', () => ({
	GROUP_NOT_FOUND: 'Group not found',
	groupView: mocks.groupView,
	requireGroupWriter: vi.fn()
}));
vi.mock('#lib/groups/server/caller.js', () => ({ callerSession: mocks.callerSession }));
vi.mock('#lib/groups/server/roster.js', () => ({
	readRoster: mocks.readRoster,
	handlesOf: vi.fn(async () => ({}))
}));

import { load } from './+page.server';

const GROUP = 'did:plc:group';
const caller = { did: 'did:plc:carol', scope: 'atproto', handle: vi.fn() };
const input = () =>
	({ params: { actor: GROUP }, locals: { did: caller.did, session: {} } }) as never;
const view = (over: Record<string, unknown>) => ({
	did: GROUP,
	name: 'Knitters',
	personal: null,
	linked: null,
	askAccess: false,
	...over
});

beforeEach(() => {
	vi.resetAllMocks();
	mocks.callerSession.mockResolvedValue(caller);
});
afterEach(() => {
	Reflect.deleteProperty(env, 'SPACES_PDS_URL');
});

describe('the members page for someone without group permissions', () => {
	it('says how to get them instead of answering that there is no group', async () => {
		mocks.groupView.mockResolvedValue(view({ askAccess: true }));
		expect(await load(input())).toMatchObject({
			hidden: true,
			needsAccess: true,
			spacesServer: null
		});
		expect(mocks.readRoster).not.toHaveBeenCalled();
	});

	it("points to the site's server with spaces support when it names one", async () => {
		mocks.groupView.mockResolvedValue(view({ askAccess: true }));
		Object.assign(env, { SPACES_PDS_URL: ' https://pds.example.com/ ' });
		expect(await load(input())).toMatchObject({
			spacesServer: { url: 'https://pds.example.com', host: 'pds.example.com' }
		});
		for (const value of ['ftp://pds.example.com', 'pds.example.com']) {
			Object.assign(env, { SPACES_PDS_URL: value });
			expect(await load(input())).toMatchObject({ spacesServer: null });
		}
	});

	it('still answers 404 when signed out, or to someone who holds the permissions', async () => {
		mocks.callerSession.mockResolvedValueOnce(null);
		mocks.groupView.mockResolvedValue(view({ askAccess: false }));
		await expect(load(input())).rejects.toMatchObject({ status: 404 });
		await expect(load(input())).rejects.toMatchObject({ status: 404 });
		expect(mocks.readRoster).not.toHaveBeenCalled();
	});
});
