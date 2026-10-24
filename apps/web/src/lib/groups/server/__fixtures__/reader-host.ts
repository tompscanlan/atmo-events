// A fake group host behind the real space reader.
//
// A page test describes the host as a `GroupSpaceReader`-shaped object (what each
// space holds, which reads fail, a log of the reads), and this fixture answers the
// reader's XRPC calls from it: `space.getRecord`, `space.listRecords` and
// `simplespace.getSpace`. The credential lookup, the session and the transport
// stay real, so a test depends on the wire format and the linked-session seam,
// never on which module builds the reader.
//
// Pages read with the caller's own access (TS 2026-10-15), so a signed-in caller
// is `readerSession(did)`, put in `locals.session`: their own PDS here grants a
// delegation token for a space their scope reads, and the host grants a
// credential to whom it lets in. By default that is whom a host lets in by its
// records: anyone for a meta space whose access record is public, the group's
// roster (its membership records) for every other space, and the group itself.
// `admitOnly` replaces the rule for one group. DIDs resolve to the stub PDS, and
// each publishes the one KEM key the host MACs its records with.
//
// A test file opts in to the session seam as ./linked-group.ts describes, gives
// its platform env `OAUTH_SESSIONS: fixtureSessions`, and calls `serveReader` in
// each test. `serveReader(did, null)` leaves the group unlinked: no reader as the
// group, and no host for anyone's reads.
import { vi } from 'vitest';
import type { OAuthSession } from '@atcute/oauth-node-client';
import { META_READ_GRANT } from '$lib/atproto/settings';
import { groupSpaceUris } from '../../ids';
import { GROUP_DECLARATION_COLLECTION, GROUP_DECLARATION_RKEY } from '../../declaration-record';
import {
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	GROUP_MEMBERSHIP_COLLECTION
} from '../../members-record';
import type { GroupSpaceReader } from '../about-read';
import { clearSpaceCredentials } from '../space-credential';
import { holdsSession, linkedServices, storedSession } from './linked-oauth-stub';
import { STUB_PDS_SERVICE } from './linked-group';
import type { FakeSpaceReader } from './space-reader';
import { fixtureKem as kem } from './space-mac-host';

import { parseGroupSessionKey } from '../session';
/** Groups whose stored session cannot be restored (`breakSession`). */
const broken = new Set<string>();

/** The sessions namespace for every group a test linked, read live, with a count
 *  of the session lookups so a test can say how many readers a request made. */
export const fixtureSessions = {
	reads: 0,
	get: async (key: string) => {
		fixtureSessions.reads++;
		const named = parseGroupSessionKey(key);
		if (!named) return null;
		const held = holdsSession(named.groupDid, named.personDid) || broken.has(named.groupDid);
		return held ? storedSession(named.personDid) : null;
	}
} as unknown as KVNamespace & { reads: number };

/** A group the store says is linked whose session then fails to restore, as an
 *  expired or revoked link would: building its reader throws. */
export function breakSession(groupDid: string): void {
	hosts.delete(groupDid);
	linkedServices.delete(groupDid);
	broken.add(groupDid);
}

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A host failure as the PDS reports it, from the error the fake threw: a status
 *  it names ("failed: 502") is the response's status, and `SpaceNotFound` keeps
 *  its code, since callers tell a missing space from other failures by it. The
 *  real transport then words the error as it would for a real host. */
function failure(e: unknown): Response {
	const message = e instanceof Error ? e.message : String(e);
	if (/\bSpaceNotFound\b/.test(message)) return json(400, { error: 'SpaceNotFound', message });
	const named = /failed: (\d{3})\b/.exec(message);
	return json(named ? Number(named[1]) : 500, { message });
}

async function answer(host: GroupSpaceReader, url: URL, headers: Headers): Promise<Response> {
	const q = Object.fromEntries(url.searchParams);
	try {
		switch (url.pathname) {
			case '/xrpc/com.atproto.space.getRecord': {
				const record = await host.get({
					space: q.space,
					repo: q.repo,
					collection: q.collection,
					rkey: q.rkey
				});
				if (!record) return json(400, { error: 'RecordNotFound' });
				const answered = await (await kem).recordAnswer(headers, record);
				const res = json(200, { uri: record.uri, cid: answered.cid, value: record.value });
				for (const [name, value] of Object.entries(answered.headers)) res.headers.set(name, value);
				return res;
			}
			case '/xrpc/com.atproto.space.listRecords': {
				const records = await host.list({
					space: q.space,
					repo: q.repo,
					...(q.collection ? { collection: q.collection } : {})
				});
				return json(200, {
					records: records.map((r) => ({
						collection: r.collection,
						rkey: r.rkey,
						cid: r.cid,
						value: r.value
					}))
				});
			}
			case '/xrpc/com.atproto.simplespace.getSpace': {
				const { readPolicy } = await host.getSpace(q.space);
				return json(200, { readPolicy: { $type: readPolicy } });
			}
		}
	} catch (e) {
		return failure(e);
	}
	throw new Error(`reader-host: no answer for ${url.pathname}`);
}

/** Where a fixture person's own PDS answers: it hands out their delegation
 *  tokens. */
export const MEMBER_PDS_SERVICE = 'https://member-pds.stub.test';

/** A sign-in that reads every group's meta space and every space of any group,
 *  so only the host decides what it gets. */
export const READ_EVERYTHING = `atproto ${META_READ_GRANT} space:*?authority=*&action=read`;

/** What each fixture person's sign-in was granted, by DID. */
const granted = new Map<string, string>();

/** A person's own signed-in session, as `locals.session` carries it. Each
 *  request goes to their PDS, here, with their DID on it. */
export function readerSession(did: string, scope: string = READ_EVERYTHING): OAuthSession {
	granted.set(did, scope);
	return {
		did,
		getTokenInfo: async () => ({ scope, expiresAt: new Date(Date.now() + 3_600_000) }),
		handle: (pathname: string, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			headers.set('authorization', `Bearer member ${did}`);
			return fetch(new URL(pathname, MEMBER_PDS_SERVICE), { ...init, headers });
		}
	} as unknown as OAuthSession;
}

/** A space URI's parts, `at://<authority>/space/<type>/<skey>`. */
function spaceParts(space: string): { authority: string; type: string } {
	const m = /^at:\/\/([^/]+)\/space\/([^/]+)\/[^/]+$/.exec(space);
	if (!m) throw new Error(`reader-host: not a space URI: ${space}`);
	return { authority: m[1], type: m[2] };
}

/** Whether `scope` reads `space` for `holder`, as getDelegationToken asks. */
function scopeReads(scope: string, holder: string, space: string): boolean {
	const { authority, type } = spaceParts(space);
	return scope.split(' ').some((token) => {
		const m = /^space:([^?]+)(?:\?(.*))?$/.exec(token);
		if (!m) return false;
		const params = new URLSearchParams(m[2] ?? '');
		const wanted = params.get('authority') ?? 'self';
		const actions = params.getAll('action');
		return (
			(m[1] === '*' || m[1] === type) &&
			(wanted === '*' || wanted === authority || (wanted === 'self' && authority === holder)) &&
			(actions.length === 0 || actions.includes('read'))
		);
	});
}

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A credential the reader can read an `exp` from, naming its holder and space. */
function credentialFor(holder: string, space: string): string {
	const exp = Math.floor(Date.now() / 1000) + 600;
	return `${b64url({ alg: 'none' })}.${b64url({ sub: holder, space, exp })}.sig`;
}

function credentialSpace(authorization: string): string | null {
	const payload = authorization.replace(/^Atproto-Space-Credential /, '').split('.')[1];
	try {
		return JSON.parse(Buffer.from(payload, 'base64url').toString()).space ?? null;
	} catch {
		return null;
	}
}

/** The member's PDS: a delegation token for a space their sign-in reads. */
function memberPds(url: URL, headers: Headers): Response {
	if (url.pathname !== '/xrpc/com.atproto.space.getDelegationToken') {
		throw new Error(`reader-host: the member PDS has no answer for ${url.pathname}`);
	}
	const holder = (headers.get('authorization') ?? '').replace(/^Bearer member /, '');
	const space = url.searchParams.get('space') ?? '';
	if (!scopeReads(granted.get(holder) ?? '', holder, space)) {
		return json(403, { error: 'ScopeMissingError', message: `Missing required scope` });
	}
	return json(200, { token: `delegation ${holder} ${space}` });
}

/** Whether each group's public repo holds its declaration, when a test says. */
const declarations = new Map<string, boolean>();

/** Says whether `groupDid`'s public repo holds its declaration, in place of the
 *  default: it does exactly while its meta space's access record is public, as
 *  atmo keeps it (FR-214). */
export function declare(groupDid: string, declared: boolean): void {
	declarations.set(groupDid, declared);
}

/** The group's public repo, which anyone may read: its declaration only. */
function publicRepo(host: GroupSpaceReader, url: URL): Response {
	const group = url.searchParams.get('repo') ?? '';
	if (
		url.searchParams.get('collection') !== GROUP_DECLARATION_COLLECTION ||
		url.searchParams.get('rkey') !== GROUP_DECLARATION_RKEY
	) {
		throw new Error(`reader-host: the public repo has no answer for ${url.search}`);
	}
	let declared = declarations.get(group);
	if (declared === undefined) {
		const access =
			'peek' in host
				? (host as FakeSpaceReader).peek({
						space: groupSpaceUris(group).aboutSpaceUri,
						repo: group,
						collection: GROUP_ACCESS_COLLECTION,
						rkey: GROUP_ACCESS_RKEY
					})
				: null;
		declared = access?.value.public === true;
	}
	if (!declared) return json(400, { error: 'RecordNotFound' });
	const uri = `at://${group}/${GROUP_DECLARATION_COLLECTION}/${GROUP_DECLARATION_RKEY}`;
	return json(200, { uri, cid: 'bafydeclaration', value: {} });
}

/** Who the host lets into a space, by group, when a test says. */
const admitRules = new Map<string, (did: string, space: string) => boolean>();

/** Replaces the default rule for `groupDid`: only `admits` decides. */
export function admitOnly(groupDid: string, admits: (did: string, space: string) => boolean) {
	admitRules.set(groupDid, admits);
}

/** Whom the host lets in, from its own records: a public meta space lets anyone
 *  in, and every space lets in the group and its roster. */
function admits(host: GroupSpaceReader, did: string, space: string): boolean {
	const group = spaceParts(space).authority;
	const rule = admitRules.get(group);
	if (rule) return rule(did, space);
	if (did === group || !('peek' in host)) return true;
	const fake = host as FakeSpaceReader;
	const { aboutSpaceUri, membersSpaceUri } = groupSpaceUris(group);
	if (space === aboutSpaceUri) {
		const access = fake.peek({
			space,
			repo: group,
			collection: GROUP_ACCESS_COLLECTION,
			rkey: GROUP_ACCESS_RKEY
		});
		if (access?.value.public === true) return true;
	}
	const record = { space: membersSpaceUri, repo: group, collection: GROUP_MEMBERSHIP_COLLECTION };
	return fake.peek({ ...record, rkey: did }) !== null;
}

/** Each served group's host, by DID. A read names its group in `space`. */
const hosts = new Map<string, GroupSpaceReader>();

/** Links `groupDid` and answers its reads from `host`, or unlinks it when `host`
 *  is null. Each group keeps its own host until the test ends. Any request this
 *  fixture cannot answer fails the test. */
export function serveReader(groupDid: string, host: GroupSpaceReader | null): void {
	if (!host) {
		hosts.delete(groupDid);
		linkedServices.delete(groupDid);
		return;
	}
	hosts.set(groupDid, host);
	linkedServices.set(groupDid, STUB_PDS_SERVICE);
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			const headers = new Headers(init?.headers);
			if (url.origin === 'https://plc.directory') {
				const did = decodeURIComponent(url.pathname.slice(1));
				return json(200, {
					id: did,
					verificationMethod: [
						{
							id: `${did}#atproto_kem`,
							type: 'Multikey',
							controller: did,
							publicKeyMultibase: (await kem).multibase
						}
					],
					service: [
						{
							id: '#atproto_pds',
							type: 'AtprotoPersonalDataServer',
							serviceEndpoint: STUB_PDS_SERVICE
						}
					]
				});
			}
			if (url.origin === MEMBER_PDS_SERVICE) return memberPds(url, headers);
			if (url.origin !== new URL(STUB_PDS_SERVICE).origin) {
				throw new Error(`reader-host: unexpected request to ${url.href}`);
			}
			if (url.pathname === '/xrpc/com.atproto.space.getSpaceCredential') {
				const body = JSON.parse(String(init?.body ?? '{}'));
				const space = String(body.space ?? '');
				const served = hosts.get(spaceParts(space).authority);
				if (!served) throw new Error(`reader-host: no host served for ${space}`);
				const [, holder, named] = String(body.delegationToken ?? '').split(' ');
				if (named !== space) return json(400, { error: 'InvalidDelegationToken' });
				if (!admits(served, holder, space)) {
					return json(400, { error: 'UserNotAuthorized', message: 'User not authorized' });
				}
				return json(200, { credential: credentialFor(holder, space) });
			}
			if (url.pathname === '/xrpc/com.atproto.repo.getRecord') {
				const served = hosts.get(url.searchParams.get('repo') ?? '');
				if (!served) throw new Error(`reader-host: no host served for ${url.href}`);
				return publicRepo(served, url);
			}
			const space = url.searchParams.get('space') ?? '';
			const authorization = headers.get('authorization') ?? '';
			if (
				authorization.startsWith('Atproto-Space-Credential ') &&
				credentialSpace(authorization) !== space
			) {
				return json(401, { error: 'InvalidToken' });
			}
			const did = /^at:\/\/([^/]+)\//.exec(space)?.[1] ?? '';
			const served = hosts.get(did);
			if (!served) throw new Error(`reader-host: no host served for ${did || url.href}`);
			return answer(served, url, headers);
		})
	);
}

/** For an `afterEach`: no host, link, sign-in, rule, kept credential or session
 *  count outlives its test. */
export function resetReaderHost(): void {
	hosts.clear();
	broken.clear();
	linkedServices.clear();
	granted.clear();
	admitRules.clear();
	declarations.clear();
	clearSpaceCredentials();
	fixtureSessions.reads = 0;
}
