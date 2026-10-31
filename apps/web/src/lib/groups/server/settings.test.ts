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

const WAS_PUBLIC = { access: PUBLIC, declared: true };
const WAS_PRIVATE = { access: PRIVATE };
const HIDDEN = { public: false, listed: false };
type Save = [string, Partial<GroupPdsState>, Partial<GroupSettings>, boolean, GroupPdsWrite[]];

/** Saves `over` the default settings from the form as `shown`, on a PDS that starts as `from`. */
async function save(from: Partial<GroupPdsState>, over: Partial<GroupSettings>, shown?: boolean) {
	const pds = groupPds(GROUP, from);
	await applyGroupSettings(pds.writer, group, settings(over), shown);
	return pds;
}

beforeEach(() => {
	vi.restoreAllMocks();
	kv = memoryKV();
	Object.assign(env, { OAUTH_SESSIONS: kv });
});

describe('applyGroupSettings', () => {
	const saves: Save[] = [
		['private', WAS_PUBLIC, HIDDEN, true, ['withdraw', 'access', 'profile']],
		['public and listed', WAS_PRIVATE, {}, false, ['access', 'declare', 'profile']],
		['public but unlisted', WAS_PRIVATE, { listed: false }, false, ['access', 'profile']],
		['unlisted', WAS_PUBLIC, { listed: false }, true, ['access', 'withdraw', 'profile']]
	];

	for (const [to, from, over, shown, order] of saves) {
		const wanted = settings(over);
		it(`takes a group ${to} by writing ${order.join(', then ')}`, async () => {
			const pds = await save(from, over, shown);
			expect(pds.writes).toEqual(order);
			expect(pds.state).toMatchObject({
				declared: wanted.listed,
				access: { public: wanted.public }
			});
		});

		it(`never leaves a private group declared when a save to ${to} stops, and saving again finishes it`, async () => {
			for (const stop of order) {
				const pds = groupPds(GROUP, structuredClone(from));
				pds.failNext = stop;
				await expect(applyGroupSettings(pds.writer, group, wanted, shown)).rejects.toBeInstanceOf(
					XrpcError
				);
				expect(pds.state.declared && pds.state.access?.public !== true).toBe(false);

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
		const madePublic = await save(WAS_PUBLIC, { name: 'Renamed', ...HIDDEN }, false);
		expect(madePublic.state).toMatchObject({
			declared: true,
			access: { public: true },
			profile: { displayName: 'Renamed' }
		});

		const madePrivate = await save(WAS_PRIVATE, {}, true);
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
		const over = { name: 'New', description: null, joinPolicy: 'approval', listed: false } as const;
		const pds = await save({ access: PUBLIC, profile }, over, true);
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
		const pds = await save({}, HIDDEN);
		expect(pds.state.access).toMatchObject({
			public: false,
			grants: [{ role: 'admin' }, { role: 'member' }]
		});
	});

	it("shows visitors a public group's card, and removes a private group's", async () => {
		const pds = await save(WAS_PRIVATE, {}, false);
		const card = (await readCards([GROUP])).get(GROUP);
		expect(card).toMatchObject({ name: 'Knitters', handle: 'knit.example' });

		await applyGroupSettings(pds.writer, group, settings(HIDDEN), true);
		expect((await readCards([GROUP])).has(GROUP)).toBe(false);
	});

	it('saves even when the card cannot be stored', async () => {
		vi.spyOn(kv, 'put').mockRejectedValue(new Error('KV down'));
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect((await save(WAS_PRIVATE, {}, false)).writes).toEqual(['access', 'declare', 'profile']);
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
