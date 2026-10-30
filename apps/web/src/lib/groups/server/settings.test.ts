import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { groupPds, type GroupPdsState, type GroupPdsWrite } from './__fixtures__/group-pds';
import { memoryKV, type MemoryKV } from './__fixtures__/kv';
import { XrpcError } from './xrpc';

vi.mock('#lib/contrail/index.js', () => ({
	getServerClient: () => ({ post: async () => ({ ok: true, data: {} }) })
}));

import { readCards } from './group';
import { applyGroupSettings, parseGroupSettings, type GroupSettings } from './settings';

const GROUP = 'did:plc:group';
const group = { did: GROUP, handle: 'knit.example' };
const PUBLIC = { public: true, grants: [{ role: 'admin', scopes: ['space:meta?action=read'] }] };
const PRIVATE = { ...PUBLIC, public: false };
let kv: MemoryKV;

const settings = (over: Partial<GroupSettings> = {}): GroupSettings => ({
	name: 'Knitters',
	description: 'We knit.',
	joinPolicy: 'open',
	public: true,
	listed: true,
	...over
});

const declaredWhilePrivate = (state: GroupPdsState) =>
	state.declared && state.access?.public !== true;

beforeEach(() => {
	vi.restoreAllMocks();
	kv = memoryKV();
	Object.assign(env, { OAUTH_SESSIONS: kv });
});

describe('applyGroupSettings', () => {
	it('takes a group private by withdrawing its declaration first, then access, then profile', async () => {
		const pds = groupPds(GROUP, { access: PUBLIC, declared: true });
		await applyGroupSettings(pds.writer, group, settings({ public: false, listed: false }), true);
		expect(pds.writes).toEqual(['withdraw', 'access', 'profile']);
		expect(pds.state).toMatchObject({ declared: false, access: { public: false } });
	});

	it('takes a group public before declaring it, and declares it only when listed', async () => {
		const listed = groupPds(GROUP, { access: PRIVATE });
		await applyGroupSettings(listed.writer, group, settings(), false);
		expect(listed.writes).toEqual(['access', 'declare', 'profile']);

		const unlisted = groupPds(GROUP, { access: PRIVATE });
		await applyGroupSettings(unlisted.writer, group, settings({ listed: false }), false);
		expect(unlisted.writes).toEqual(['access', 'profile']);
	});

	it('withdraws a public group that is no longer listed', async () => {
		const pds = groupPds(GROUP, { access: PUBLIC, declared: true });
		await applyGroupSettings(pds.writer, group, settings({ listed: false }), true);
		expect(pds.writes).toEqual(['access', 'withdraw', 'profile']);
		expect(pds.state).toMatchObject({ declared: false, access: { public: true } });
	});

	const saves: [string, Partial<GroupPdsState>, GroupSettings, boolean, GroupPdsWrite[]][] = [
		[
			'private',
			{ access: PUBLIC, declared: true },
			settings({ public: false, listed: false }),
			true,
			['withdraw', 'access', 'profile']
		],
		['public', { access: PRIVATE }, settings(), false, ['access', 'declare', 'profile']]
	];
	for (const [to, from, wanted, shown, order] of saves) {
		it(`never leaves a private group declared when a save to ${to} stops, and saving again finishes it`, async () => {
			for (const stop of order) {
				const pds = groupPds(GROUP, structuredClone(from));
				pds.failNext = stop;
				await expect(applyGroupSettings(pds.writer, group, wanted, shown)).rejects.toBeInstanceOf(
					XrpcError
				);
				expect(declaredWhilePrivate(pds.state)).toBe(false);

				await applyGroupSettings(pds.writer, group, wanted, shown);
				expect(pds.state).toMatchObject({
					declared: wanted.listed,
					access: { public: wanted.public },
					profile: { displayName: wanted.name }
				});
			}
		});
	}

	it('keeps a visibility someone changed after the form was shown, and its listing', async () => {
		const madePublic = groupPds(GROUP, { access: PUBLIC, declared: true });
		const stale = settings({ name: 'Renamed', public: false, listed: false });
		await applyGroupSettings(madePublic.writer, group, stale, false);
		expect(madePublic.state).toMatchObject({
			declared: true,
			access: { public: true },
			profile: { displayName: 'Renamed' }
		});

		const madePrivate = groupPds(GROUP, { access: PRIVATE });
		await applyGroupSettings(madePrivate.writer, group, settings(), true);
		expect(madePrivate.state).toMatchObject({ declared: false, access: { public: false } });
	});

	it("keeps the record fields it does not set, and drops a description that's cleared", async () => {
		const blob = { $type: 'blob', ref: { $link: 'bafy' }, mimeType: 'image/png', size: 9 };
		const profile = {
			$type: 'group.opensocial.profile',
			displayName: 'Old',
			description: 'Old words',
			avatar: blob,
			banner: blob,
			url: 'https://knit.example'
		};
		const pds = groupPds(GROUP, { access: PUBLIC, profile });
		await applyGroupSettings(
			pds.writer,
			group,
			settings({ name: 'New', description: null, joinPolicy: 'approval', listed: false }),
			true
		);
		expect(pds.state.profile).toEqual({
			$type: 'group.opensocial.profile',
			displayName: 'New',
			joinPolicy: 'approval',
			avatar: blob,
			banner: blob,
			url: 'https://knit.example'
		});
		expect(pds.state.access).toEqual({ ...PUBLIC, $type: 'group.opensocial.access' });
	});

	it('gives a new group an access record its admins and members can read by', async () => {
		const pds = groupPds(GROUP);
		await applyGroupSettings(pds.writer, group, settings({ public: false, listed: false }));
		const grants = pds.state.access?.grants as { role: string }[];
		expect(pds.state.access?.public).toBe(false);
		expect(grants.map((g) => g.role)).toEqual(['admin', 'member']);
	});

	it("shows visitors a public group's card, and removes a private group's", async () => {
		const pds = groupPds(GROUP, { access: PRIVATE });
		await applyGroupSettings(pds.writer, group, settings(), false);
		expect((await readCards([GROUP])).get(GROUP)).toMatchObject({
			name: 'Knitters',
			handle: 'knit.example'
		});

		await applyGroupSettings(pds.writer, group, settings({ public: false, listed: false }), true);
		expect((await readCards([GROUP])).has(GROUP)).toBe(false);
	});

	it('saves even when the card cannot be stored', async () => {
		vi.spyOn(kv, 'put').mockRejectedValue(new Error('KV down'));
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const pds = groupPds(GROUP, { access: PRIVATE });
		await expect(applyGroupSettings(pds.writer, group, settings(), false)).resolves.toBeUndefined();
		expect(pds.writes).toEqual(['access', 'declare', 'profile']);
	});
});

describe('parseGroupSettings', () => {
	const form = {
		name: ' Knitters ',
		description: '  ',
		joinPolicy: 'open',
		public: true,
		listed: true
	};

	it('trims, and reads a blank description as none', () => {
		expect(parseGroupSettings(form)).toEqual({
			name: 'Knitters',
			description: null,
			joinPolicy: 'open',
			public: true,
			listed: true
		});
	});

	it("needs a name, and holds both to the profile lexicon's bounds in graphemes", () => {
		expect(parseGroupSettings({ ...form, name: '   ' })).toBeNull();
		expect(parseGroupSettings({ ...form, name: 'k'.repeat(65) })).toBeNull();
		expect(parseGroupSettings({ ...form, name: '👩‍👩‍👧'.repeat(64) })?.name).toHaveLength(
			'👩‍👩‍👧'.length * 64
		);
		expect(parseGroupSettings({ ...form, description: 'k'.repeat(2001) })).toBeNull();
	});

	it('refuses an unknown join policy, and a visibility that is not a yes or no', () => {
		expect(parseGroupSettings({ ...form, joinPolicy: 'anyone' })).toBeNull();
		expect(parseGroupSettings({ ...form, public: 'true' })).toBeNull();
		expect(parseGroupSettings({ ...form, listed: undefined })).toBeNull();
		expect(parseGroupSettings(null)).toBeNull();
	});

	it('lists only a public group', () => {
		expect(parseGroupSettings({ ...form, public: false, listed: true })?.listed).toBe(false);
	});
});
