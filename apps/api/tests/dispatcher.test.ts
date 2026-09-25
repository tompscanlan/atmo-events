import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '@atmo-dev/contrail/sqlite';
import worker, { routeFor } from '../src/dispatcher';
import type { OpenmeetApiEnv } from '../src/spaces';

const ENDPOINT = 'https://api.openmeet.example';

const env: OpenmeetApiEnv = {
	// The SQLite driver implements the same prepare/batch surface both runtimes
	// use; only the nominal Cloudflare binding type differs.
	DB: createSqliteDatabase(':memory:') as unknown as D1Database,
	SPACES_CREDENTIAL_ENCRYPTION_KEY: btoa('\u0007'.repeat(32)),
	PUBLIC_SERVICE_ENDPOINT: ENDPOINT
};

const ctx = {
	waitUntil() {},
	passThroughOnException() {}
} as unknown as ExecutionContext;

/** Neither runtime reads `cf`, so a plain Request stands in for an edge one. */
function incoming(path: string): Request<unknown, IncomingRequestCfProperties> {
	return new Request(`${ENDPOINT}${path}`) as unknown as Request<
		unknown,
		IncomingRequestCfProperties
	>;
}

async function body(path: string): Promise<any> {
	const response = await worker.fetch(incoming(path), env, ctx);
	expect(response.status).toBe(200);
	return response.json();
}

describe('runtime routing table', () => {
	it('gives every Space namespace to the Spaces provider', () => {
		expect(routeFor('/xrpc/com.atproto.space.notifyWrite')).toBe('spaces');
		expect(routeFor('/xrpc/com.atproto.space.notifySpaceDeleted')).toBe('spaces');
		expect(routeFor('/xrpc/com.atproto.simplespace.checkUserAccess')).toBe('spaces');
		expect(routeFor('/xrpc/net.openmeet.group.authorizeSpace')).toBe('spaces');
		expect(routeFor('/xrpc/net.openmeet.group.syncSpace')).toBe('spaces');
		expect(routeFor('/xrpc/net.openmeet.group.listSpaces')).toBe('spaces');
		expect(routeFor('/xrpc/net.openmeet.group.event.listSpaceRecords')).toBe('spaces');
		expect(routeFor('/xrpc/net.openmeet.group.rsvp.getSpaceRecord')).toBe('spaces');
		expect(routeFor('/.well-known/contrail-spaces-alpha')).toBe('spaces');
	});

	it('keeps the public index and its discovery on Contrail', () => {
		expect(routeFor('/xrpc/rsvp.atmo.event.listRecords')).toBe('contrail');
		expect(routeFor('/xrpc/rsvp.atmo.event.listDiscoverable')).toBe('contrail');
		expect(routeFor('/xrpc/rsvp.atmo.getFeed')).toBe('contrail');
		expect(routeFor('/.well-known/contrail')).toBe('contrail');
		expect(routeFor('/lexicons/sha256:abc')).toBe('contrail');
		expect(routeFor('/status')).toBe('contrail');
		expect(routeFor('/')).toBe('contrail');
	});

	it('merges only the two paths both runtimes claim', () => {
		expect(routeFor('/.well-known/did.json')).toBe('merged');
		expect(routeFor('/lexicons')).toBe('merged');
	});

	it('does not hand a lookalike namespace to the Spaces provider', () => {
		expect(routeFor('/xrpc/com.atproto.repo.getRecord')).toBe('contrail');
		expect(routeFor('/xrpc/net.openmeetgroup.listSpaces')).toBe('contrail');
	});
});

describe('merged discovery documents', () => {
	it('publishes both the Contrail and the Space service entries', async () => {
		const document = await body('/.well-known/did.json');
		expect(document.id).toBe('did:web:api.openmeet.example');
		expect(document.service).toEqual(
			expect.arrayContaining([
				{
					id: 'did:web:api.openmeet.example#contrail',
					type: 'ContrailService',
					serviceEndpoint: ENDPOINT
				},
				{
					id: 'did:web:api.openmeet.example#spaces',
					type: 'AtprotoSpaceService',
					serviceEndpoint: ENDPOINT
				}
			])
		);
	});

	it('merges both Lexicon bundles at /lexicons', async () => {
		const bundle = await body('/lexicons');
		const ids = bundle.lexicons.map((document: { id: string }) => document.id);
		expect(ids).toEqual(expect.arrayContaining(['rsvp.atmo.getFeed', 'rsvp.atmo.notifyOfUpdate']));
		expect(ids).toEqual(
			expect.arrayContaining([
				'net.openmeet.group.authorizeSpace',
				'net.openmeet.group.syncSpace',
				'net.openmeet.group.listSpaces',
				'net.openmeet.group.event.listSpaceRecords',
				'net.openmeet.group.event.getSpaceRecord',
				'net.openmeet.group.rsvp.listSpaceRecords',
				'net.openmeet.group.rsvp.getSpaceRecord'
			])
		);
		expect(new Set(ids).size).toBe(ids.length);
		expect([...ids].sort()).toEqual(ids);
	});

	it('leaves the digest-addressed bundle unmerged', async () => {
		const manifest = await body('/.well-known/contrail');
		const digest = manifest.lexicons.digest as string;
		const response = await worker.fetch(incoming(`/lexicons/${digest}`), env, ctx);
		expect(response.status).toBe(200);
		expect(response.headers.get('etag')).toBe(`"${digest}"`);
		const pinned = (await response.json()) as { lexicons: Array<{ id: string }> };
		expect(pinned.lexicons.some((document) => document.id.startsWith('net.openmeet.group.'))).toBe(
			false
		);
	});
});
