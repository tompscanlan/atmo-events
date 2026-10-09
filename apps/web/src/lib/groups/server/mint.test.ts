import { afterEach, describe, expect, it, vi } from 'vitest';
import { Secp256k1PrivateKeyExportable, parsePrivateMultikey } from '@atcute/crypto';
import {
	GroupMintError,
	assertOwnerHoldsRotationKey,
	mintGroupAccount,
	type GroupLogin,
	type MintConfig
} from './mint';

const CFG: MintConfig = {
	service: 'https://pds.example.net',
	handleDomain: 'group.example.net',
	inviteCode: 'example-net-aaaaa-bbbbb'
};

/** The login the creator typed. */
const LOGIN: GroupLogin = { email: 'alice+kona@example.com', password: 'correct horse battery' };

const DID = 'did:plc:mintedgroupaaaaaaaaaaaaa';

interface Call {
	url: string;
	body: Record<string, unknown>;
	auth: string | undefined;
}

/** Records every XRPC call and answers createAccount. Any other call throws, so a
 *  call the mint should not make fails the case. */
function stubPds(overrides: { account?: Response } = {}) {
	const calls: Call[] = [];
	vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
		const url = String(input);
		calls.push({
			url,
			body: init?.body ? JSON.parse(String(init.body)) : {},
			auth: (init?.headers as Record<string, string> | undefined)?.authorization
		});
		if (url.includes('createAccount')) {
			return (
				overrides.account ??
				Response.json({ did: DID, handle: 'kona.group.example.net', accessJwt: 'master-jwt' })
			);
		}
		throw new Error(`unexpected call to ${url}`);
	});
	return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('mintGroupAccount', () => {
	it('registers the handle under the group domain with the login the creator typed', async () => {
		const calls = stubPds();
		const minted = await mintGroupAccount(CFG, 'kona', LOGIN, async () => {});

		const account = calls.find((c) => c.url.includes('createAccount'));
		expect(account?.body.handle).toBe('kona.group.example.net');
		// Exactly as typed: no plus address of ours, no generated password.
		expect(account?.body.email).toBe(LOGIN.email);
		expect(account?.body.password).toBe(LOGIN.password);
		expect(account?.body.inviteCode).toBe(CFG.inviteCode);
		expect(minted.did).toBe(DID);
	});

	// The owner's key must be in the genesis operation, so it has to go on the
	// createAccount call itself: a PLC operation cannot be amended afterwards
	// without a key we do not have.
	it('sends the owner rotation key as recoveryKey at mint', async () => {
		const calls = stubPds();
		const minted = await mintGroupAccount(CFG, 'kona', LOGIN, async () => {});

		const account = calls.find((c) => c.url.includes('createAccount'));
		expect(account?.body.recoveryKey).toBe(minted.ownerRotationKey);
		expect(minted.ownerRotationKey).toMatch(/^did:key:z/);
		// Revealed once to the owner, and distinct from the public half.
		expect(minted.ownerRotationSecret).toBeTruthy();
		expect(minted.ownerRotationSecret).not.toBe(minted.ownerRotationKey);
	});

	// The create request sets the group up with the session createAccount
	// returned. The password the creator typed goes no further than the PDS: it
	// is not in what the mint hands back, so nothing downstream can keep it.
	it('returns the session createAccount issued, and never the password', async () => {
		stubPds();
		const minted = await mintGroupAccount(CFG, 'kona', LOGIN, async () => {});

		expect(minted.credential).toEqual({
			kind: 'mint-session',
			service: CFG.service,
			did: DID,
			accessJwt: 'master-jwt'
		});
		expect(JSON.stringify(minted)).not.toContain(LOGIN.password);
		expect(JSON.stringify(minted)).not.toContain(LOGIN.email);
	});

	it('refuses before any call when the deployment holds no invite code', async () => {
		const calls = stubPds();
		await expect(mintGroupAccount({ ...CFG, inviteCode: '' }, 'kona', LOGIN)).rejects.toMatchObject(
			{
				failure: 'invite-missing'
			}
		);
		expect(calls).toHaveLength(0);
	});

	// The `InvalidRequest` rows are the shapes the PDS really sends, told apart
	// only by the message. Its createAccount pre-check throws a plain
	// InvalidRequest for a taken handle, and only a later path uses
	// `HandleNotAvailable`, so a mapping by error name alone would send a
	// duplicate name to `pds-refused`.
	//
	// The PDS gives a used-up, nonexistent, disabled or taken-down code one
	// message, and a missing code its own. Merging the four is deliberate, because
	// the create path may not use admin credentials to tell them apart; merging
	// all five would lose the one distinction that exists.
	it.each([
		['InvalidRequest', 'Handle already taken: kona.groups.example.com', 'handle-taken'],
		['InvalidRequest', 'Email already taken: alice+kona@example.com', 'email-rejected'],
		['InvalidInviteCode', 'No invite code provided', 'invite-missing'],
		['InvalidInviteCode', 'Provided invite code not available', 'invite-unavailable']
	])('maps %s/%s to %s', async (error, message, failure) => {
		stubPds({ account: Response.json({ error, message }, { status: 400 }) });
		await expect(mintGroupAccount(CFG, 'kona', LOGIN, async () => {})).rejects.toMatchObject({
			failure
		});
	});

	// A refusal no row above maps is the PDS's answer, not an outage, so it is told
	// apart from one, and its error name is kept for the operator's log. This is
	// the refusal a misconfigured handle domain gets ("kona..groups.example.com").
	it('reports a refusal it does not map as refused, with the error name only', async () => {
		stubPds({
			account: Response.json(
				{
					error: 'InvalidRequest',
					message: 'Invalid handle (got "kona..groups.example.com") at $.handle'
				},
				{ status: 400 }
			)
		});
		await expect(mintGroupAccount(CFG, 'kona', LOGIN, async () => {})).rejects.toMatchObject({
			failure: 'pds-refused',
			pdsError: 'InvalidRequest'
		});
	});

	it('reports an unreachable PDS rather than throwing a transport error', async () => {
		vi.stubGlobal('fetch', async () => {
			throw new TypeError('network down');
		});
		await expect(mintGroupAccount(CFG, 'kona', LOGIN, async () => {})).rejects.toMatchObject({
			failure: 'pds-unreachable'
		});
	});

	// A group whose owner does not hold rotationKeys[0] is not really portable,
	// so the mint must fail loudly rather than return a group only we can move.
	it('fails when the rotation-key read-back does not confirm the owner', async () => {
		stubPds();
		await expect(
			mintGroupAccount(CFG, 'kona', LOGIN, async () => {
				throw new GroupMintError('rotation-key-unverified', 'rotationKeys[0] is ours');
			})
		).rejects.toMatchObject({ failure: 'rotation-key-unverified' });
	});
});

/** The public did:key for a private multikey: what the PDS was sent. */
async function publicKeyOf(secret: string): Promise<string> {
	const { privateKeyBytes } = parsePrivateMultikey(secret);
	const key = await Secp256k1PrivateKeyExportable.importRaw(privateKeyBytes);
	return key.exportPublicKey('did');
}

// Once createAccount succeeds the did:plc exists, and the owner's key has no
// other copy. A step after that which fails must hand the key back with the
// error, or the owner of a permanent identity never sees it.
describe('mintGroupAccount: a failure after the account exists', () => {
	it.each([
		[
			'createAccount returns no access token',
			() =>
				stubPds({
					account: Response.json({ did: DID, handle: 'kona.group.example.net' })
				}),
			async () => {}
		],
		[
			'the rotation key cannot be confirmed',
			() => stubPds(),
			async () => {
				throw new GroupMintError('rotation-key-unverified', 'directory unreachable');
			}
		]
	])('hands back the DID, the handle and the key when %s', async (_why, arrange, verify) => {
		const calls = arrange();

		const error = await mintGroupAccount(CFG, 'kona', LOGIN, verify).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(GroupMintError);
		const { registered } = error as GroupMintError;
		expect(registered).toMatchObject({ did: DID, handle: 'kona.group.example.net' });
		// The very key the account was registered with, not merely a key.
		const sent = calls.find((c) => c.url.includes('createAccount'))?.body.recoveryKey;
		expect(await publicKeyOf(registered!.recoveryKey)).toBe(sent);
	});

	it('hands back nothing when the account was never created', async () => {
		stubPds({ account: Response.json({ error: 'HandleNotAvailable' }, { status: 400 }) });
		const error = await mintGroupAccount(CFG, 'kona', LOGIN, async () => {}).catch(
			(e: unknown) => e
		);
		expect(error).toBeInstanceOf(GroupMintError);
		expect((error as GroupMintError).registered).toBeUndefined();
	});
});

describe('assertOwnerHoldsRotationKey', () => {
	it('accepts a genesis operation whose first rotation key is the owner’s', async () => {
		vi.stubGlobal('fetch', async () =>
			Response.json({ rotationKeys: ['did:key:zOwner', 'did:key:zPds'] })
		);
		await expect(assertOwnerHoldsRotationKey(DID, 'did:key:zOwner')).resolves.toBeUndefined();
	});

	// Index matters, not membership: PLC resolves conflicting operations by key
	// order, so an owner key behind ours cannot move the DID against us.
	it('refuses when the owner key is present but not first', async () => {
		vi.stubGlobal('fetch', async () =>
			Response.json({ rotationKeys: ['did:key:zPds', 'did:key:zOwner'] })
		);
		await expect(assertOwnerHoldsRotationKey(DID, 'did:key:zOwner')).rejects.toMatchObject({
			failure: 'rotation-key-unverified'
		});
	});

	it('refuses when the directory cannot be read', async () => {
		vi.stubGlobal('fetch', async () => new Response('nope', { status: 502 }));
		await expect(assertOwnerHoldsRotationKey(DID, 'did:key:zOwner')).rejects.toMatchObject({
			failure: 'rotation-key-unverified'
		});
	});
});
