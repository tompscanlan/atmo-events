import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	GroupMintError,
	assertOwnerHoldsRotationKey,
	mintGroupAccount,
	type MintConfig
} from './mint';

const CFG: MintConfig = {
	service: 'https://pds.example.net',
	handleDomain: 'group.example.net',
	inviteCode: 'example-net-aaaaa-bbbbb',
	accountEmail: 'groups@openmeet.net'
};

const DID = 'did:plc:mintedgroupaaaaaaaaaaaaa';

interface Call {
	url: string;
	body: Record<string, unknown>;
	auth: string | undefined;
}

/** Records every XRPC call and answers createAccount + createAppPassword. */
function stubPds(overrides: { account?: Response; appPassword?: Response } = {}) {
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
		if (url.includes('createAppPassword')) {
			return overrides.appPassword ?? Response.json({ password: 'app-pass-1234' });
		}
		throw new Error(`unexpected call to ${url}`);
	});
	return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('mintGroupAccount', () => {
	it('registers the handle under the group domain and plus-addresses the email', async () => {
		const calls = stubPds();
		const minted = await mintGroupAccount(CFG, 'kona', async () => {});

		const account = calls.find((c) => c.url.includes('createAccount'));
		expect(account?.body.handle).toBe('kona.group.example.net');
		expect(account?.body.email).toBe('groups+kona@openmeet.net');
		expect(account?.body.inviteCode).toBe(CFG.inviteCode);
		expect(minted.did).toBe(DID);
	});

	// The owner's key must be IN the genesis operation, so it has to ride on the
	// createAccount call itself — a PLC operation cannot be amended afterwards
	// without a key we do not have. (Spec: FR-001g.)
	it('sends the owner rotation key as recoveryKey at mint', async () => {
		const calls = stubPds();
		const minted = await mintGroupAccount(CFG, 'kona', async () => {});

		const account = calls.find((c) => c.url.includes('createAccount'));
		expect(account?.body.recoveryKey).toBe(minted.ownerRotationKey);
		expect(minted.ownerRotationKey).toMatch(/^did:key:z/);
		// Revealed once to the owner, and distinct from the public half.
		expect(minted.ownerRotationSecret).toBeTruthy();
		expect(minted.ownerRotationSecret).not.toBe(minted.ownerRotationKey);
	});

	// What we keep must be the app password, not the account's master — the master
	// is what could change the password or delete the account, and a D1 read or
	// backup must never yield account takeover. (Spec: FR-001f.)
	it('keeps the app password and never returns the master', async () => {
		const calls = stubPds();
		const minted = await mintGroupAccount(CFG, 'kona', async () => {});

		const account = calls.find((c) => c.url.includes('createAccount'));
		const issued = calls.find((c) => c.url.includes('createAppPassword'));
		expect(issued?.auth).toBe('Bearer master-jwt');
		expect(minted.credential.password).toBe('app-pass-1234');
		expect(minted.credential.password).not.toBe(account?.body.password);
		expect(JSON.stringify(minted)).not.toContain(String(account?.body.password));
	});

	it('refuses before any call when the deployment holds no invite code', async () => {
		const calls = stubPds();
		await expect(mintGroupAccount({ ...CFG, inviteCode: '' }, 'kona')).rejects.toMatchObject({
			failure: 'invite-missing'
		});
		expect(calls).toHaveLength(0);
	});

	// The PDS gives spent, nonexistent, disabled and taken-down ONE string, while
	// a missing code has its own. Collapsing the four is deliberate, because the
	// create path may not use admin credentials to tell them apart; collapsing all
	// five would lose the one distinction that exists. (Spec: FR-001e.)
	//
	// THE `InvalidRequest` ROWS ARE THE LIVE SHAPES, measured on pds.opnmt.net
	// 2026-09-18 during T006c. The table used to assert only the
	// `HandleNotAvailable` form, which this fork sends from
	// `account-manager.ts:374` but NOT from the `createAccount` pre-check
	// (`createAccount.ts:255,257`) that a create actually hits — so a duplicate
	// name mapped to `pds-unreachable` in production while this test was green.
	it.each([
		['HandleNotAvailable', 'Handle already taken', 'handle-taken'],
		['HandleNotAvailable', 'Reserved handle', 'handle-taken'],
		['InvalidRequest', 'Handle already taken: kona.group.opnmt.net', 'handle-taken'],
		['InvalidHandle', 'Handle too long', 'handle-invalid'],
		['InvalidInviteCode', 'No invite code provided', 'invite-missing'],
		['InvalidInviteCode', 'Provided invite code not available', 'invite-unavailable'],
		['InvalidRequest', 'Email already taken: groups+kona@openmeet.net', 'email-rejected'],
		['InvalidRequest', 'Email is required', 'email-rejected']
	])('maps %s/%s to %s', async (error, message, failure) => {
		stubPds({ account: Response.json({ error, message }, { status: 400 }) });
		await expect(mintGroupAccount(CFG, 'kona', async () => {})).rejects.toMatchObject({ failure });
	});

	it('reports an unreachable PDS rather than throwing a transport error', async () => {
		vi.stubGlobal('fetch', async () => {
			throw new TypeError('network down');
		});
		await expect(mintGroupAccount(CFG, 'kona', async () => {})).rejects.toMatchObject({
			failure: 'pds-unreachable'
		});
	});

	// A group whose owner does NOT hold rotationKeys[0] is portable in name only,
	// so the mint must fail loudly rather than hand back a group we alone can move.
	it('fails when the rotation-key read-back does not confirm the owner', async () => {
		stubPds();
		await expect(
			mintGroupAccount(CFG, 'kona', async () => {
				throw new GroupMintError('rotation-key-unverified', 'rotationKeys[0] is ours');
			})
		).rejects.toMatchObject({ failure: 'rotation-key-unverified' });
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
	// precedence, so an owner key BEHIND ours cannot move the DID against us.
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
