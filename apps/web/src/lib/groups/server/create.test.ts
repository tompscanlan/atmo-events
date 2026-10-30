import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { groupPds } from './__fixtures__/group-pds';
import { memoryKV, type MemoryKV } from './__fixtures__/kv';
import { XrpcError } from './xrpc';

vi.mock('#lib/contrail/index.js', () => ({
	getServerClient: () => ({ post: async () => ({ ok: true, data: {} }) })
}));

import { finishSetup, pendingSetup, type PendingSetup } from './create';
import type { GroupSettings } from './settings';

const GROUP = 'did:plc:group';
const ALICE = 'did:plc:alice';
// Kept across deploys, so its key is part of the stored format.
const MARKER = `group:setup:${GROUP}`;
const group = { did: GROUP, handle: 'knit.example' };
const settings: GroupSettings = {
	name: 'Knitters',
	description: null,
	joinPolicy: 'approval',
	public: true,
	listed: true
};
const setup: PendingSetup = { settings, by: ALICE };
let kv: MemoryKV;

beforeEach(() => {
	kv = memoryKV();
	Object.assign(env, { OAUTH_SESSIONS: kv });
});

describe('pendingSetup', () => {
	it('is the kept settings and who started them', async () => {
		await kv.put(MARKER, JSON.stringify(setup));
		expect(await pendingSetup(GROUP)).toEqual(setup);
	});

	it('is nothing when no marker is kept, or what is kept does not hold', async () => {
		expect(await pendingSetup(GROUP)).toBeNull();
		await kv.put(MARKER, JSON.stringify({ settings: { ...settings, name: '' }, by: ALICE }));
		expect(await pendingSetup(GROUP)).toBeNull();
		await kv.put(MARKER, JSON.stringify({ settings }));
		expect(await pendingSetup(GROUP)).toBeNull();
		Reflect.deleteProperty(env, 'OAUTH_SESSIONS');
		expect(await pendingSetup(GROUP)).toBeNull();
	});
});

describe('finishSetup', () => {
	it('keeps the marker until the last write lands, then removes it', async () => {
		const pds = groupPds(GROUP);
		const seen: (PendingSetup | null)[] = [];
		pds.beforeWrite = async () => seen.push(await pendingSetup(GROUP));

		await finishSetup(pds.writer, group, setup);
		expect(pds.writes).toEqual(['access', 'declare', 'profile']);
		expect(seen).toEqual([setup, setup, setup]);
		expect(await pendingSetup(GROUP)).toBeNull();
	});

	it('leaves the rest to its creator when a write stops, and finishing again completes it', async () => {
		const pds = groupPds(GROUP);
		pds.failNext = 'profile';
		await expect(finishSetup(pds.writer, group, setup)).rejects.toBeInstanceOf(XrpcError);

		const left = await pendingSetup(GROUP);
		expect(left).toEqual(setup);
		await finishSetup(pds.writer, group, left as PendingSetup);
		expect(pds.state).toMatchObject({
			declared: true,
			access: { public: true },
			profile: { displayName: 'Knitters', joinPolicy: 'approval' }
		});
		expect(await pendingSetup(GROUP)).toBeNull();
	});
});
