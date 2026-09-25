/**
 * Worker entry: one Worker, two runtimes.
 *
 * - Contrail serves the anonymous public index (`rsvp.atmo.*`), which includes
 *   the public events a group account writes to its public repo.
 * - The Spaces provider serves the members-only slice (`net.openmeet.group.*`)
 *   and the AT Protocol Space callbacks (`com.atproto.space.*`).
 *
 * Both runtimes answer `GET /.well-known/did.json` and `GET /lexicons`. A
 * dispatcher that tried one runtime and fell back to the other would publish
 * only one service entry. So those two paths are merged here, and every other
 * path routes by prefix.
 */
import { createWorker } from '@atmo-dev/contrail/worker';
import type { SpacesWorkerHandler } from '@atmo-dev/contrail-spaces-alpha/worker';
import { lexicons } from '../lexicons/generated';
import { contrailConfigFor } from './contrail.config';
import { publicServiceEndpoint } from './service';
import { createGroupSpaces, SPACES_NAMESPACE, type ApiEnv } from './spaces';

/** The part of Contrail's prebuilt Worker entrypoint this dispatcher drives. */
export interface ContrailRuntime {
	fetch(request: Request, env: ApiEnv, ctx?: ExecutionContext): Promise<Response>;
	scheduled(event: ScheduledEvent, env: ApiEnv, ctx: ExecutionContext): Promise<void>;
}

export type SpacesRuntime = SpacesWorkerHandler<ApiEnv>;
type SpacesQueueBatch = Parameters<NonNullable<SpacesRuntime['queue']>>[0];

export type ApiRoute = 'contrail' | 'spaces' | 'merged';

/** Both runtimes answer these; the dispatcher combines the two answers. */
const MERGED_PATHS: Record<string, true> = {
	'/.well-known/did.json': true,
	'/lexicons': true
};

/** Served only by the Spaces provider. */
const SPACES_PATHS: Record<string, true> = {
	'/.well-known/contrail-spaces-alpha': true
};

/** XRPC method prefixes owned by the Spaces provider. */
const SPACES_XRPC_PREFIXES = [
	'com.atproto.space.',
	'com.atproto.simplespace.',
	`${SPACES_NAMESPACE}.`
];

const XRPC_PREFIX = '/xrpc/';

/**
 * Total wall budget one cron tick spends, split between the two runtimes.
 * Contrail's Jetstream drain is capped at the first half so it cannot consume
 * the whole window while a Space reconcile waits behind it on D1.
 */
const SCHEDULED_WINDOW_MS = 24_000;
const CONTRAIL_INGEST_MS = SCHEDULED_WINDOW_MS / 2;

/** The single source of truth for which runtime owns a request path. */
export function routeFor(pathname: string): ApiRoute {
	if (MERGED_PATHS[pathname] === true) return 'merged';
	if (SPACES_PATHS[pathname] === true) return 'spaces';
	if (pathname.startsWith(XRPC_PREFIX)) {
		const method = pathname.slice(XRPC_PREFIX.length);
		for (const prefix of SPACES_XRPC_PREFIXES) {
			if (method.startsWith(prefix)) return 'spaces';
		}
	}
	return 'contrail';
}

interface ApiRuntimes {
	endpoint: string;
	contrail: ContrailRuntime;
	spaces: SpacesRuntime;
}

let cached: ApiRuntimes | undefined;

/**
 * Both runtimes are built from the serving origin, which is only readable from
 * `env`, so construction is per-isolate and memoized rather than module-level.
 */
function runtimes(env: ApiEnv): ApiRuntimes {
	const endpoint = publicServiceEndpoint(env);
	if (cached?.endpoint === endpoint) return cached;
	const contrail = createWorker<ApiEnv>(contrailConfigFor(endpoint), {
		lexicons,
		publicService: { endpoint },
		scheduledIngest: { maxDrainMs: CONTRAIL_INGEST_MS }
	});
	cached = { endpoint, contrail, spaces: createGroupSpaces(endpoint) };
	return cached;
}

function mergedHeaders(source: Response, contentType: string): Headers {
	const headers = new Headers(source.headers);
	// The body is a merge of two documents, so an upstream length or bundle
	// digest header would describe something this response is not.
	headers.delete('content-length');
	headers.delete('etag');
	headers.set('content-type', contentType);
	return headers;
}

async function jsonObject(response: Response): Promise<object | undefined> {
	if (!response.ok) return undefined;
	const body: unknown = await response.json();
	return body !== null && typeof body === 'object' ? body : undefined;
}

/** Merge both service entries into one DID document. */
export async function mergeDidDocuments(
	contrailResponse: Response,
	spacesResponse: Response
): Promise<Response> {
	const services: unknown[] = [];
	const seen: Record<string, true> = {};
	let id: string | undefined;
	let context: unknown;
	for (const response of [contrailResponse, spacesResponse]) {
		const document = await jsonObject(response);
		if (!document) continue;
		if (id === undefined && 'id' in document && typeof document.id === 'string') {
			id = document.id;
		}
		if (context === undefined && '@context' in document) context = document['@context'];
		const listed = 'service' in document ? document.service : undefined;
		for (const entry of Array.isArray(listed) ? listed : []) {
			if (entry === null || typeof entry !== 'object' || !('id' in entry)) continue;
			const serviceId = entry.id;
			if (typeof serviceId !== 'string' || seen[serviceId] === true) continue;
			seen[serviceId] = true;
			services.push(entry);
		}
	}
	if (id === undefined) return contrailResponse;
	const headers = mergedHeaders(contrailResponse, 'application/did+ld+json; charset=UTF-8');
	headers.set('cache-control', 'public, max-age=300');
	return new Response(
		JSON.stringify({
			'@context': context ?? ['https://www.w3.org/ns/did/v1'],
			id,
			service: services
		}),
		{ status: 200, headers }
	);
}

/**
 * Merge the public Contrail bundle (`{ lexicons: [...] }`) with the Spaces
 * provider bundle (a bare array) into Contrail's canonical envelope. The
 * digest-verified bundle stays at `/lexicons/<digest>`, which routes to
 * Contrail untouched, so nothing that checks the manifest digest is affected.
 */
export async function mergeLexiconBundles(
	contrailResponse: Response,
	spacesResponse: Response
): Promise<Response> {
	const envelope = await jsonObject(contrailResponse);
	if (!envelope) return contrailResponse;
	const publicBundle = 'lexicons' in envelope ? envelope.lexicons : undefined;
	const spacesBundle: unknown = spacesResponse.ok ? await spacesResponse.json() : undefined;
	const documents: Record<string, unknown> = {};
	for (const bundle of [publicBundle, spacesBundle]) {
		for (const document of Array.isArray(bundle) ? bundle : []) {
			if (document === null || typeof document !== 'object' || !('id' in document)) continue;
			const documentId = document.id;
			if (typeof documentId !== 'string' || documentId in documents) continue;
			documents[documentId] = document;
		}
	}
	const merged = Object.keys(documents)
		.sort()
		.map((documentId) => documents[documentId]);
	const headers = mergedHeaders(contrailResponse, 'application/json; charset=UTF-8');
	headers.set('cache-control', 'no-cache');
	return new Response(JSON.stringify({ lexicons: merged }), { status: 200, headers });
}

export default {
	async fetch(
		request: Request<unknown, IncomingRequestCfProperties>,
		env: ApiEnv,
		ctx: ExecutionContext
	): Promise<Response> {
		const { contrail, spaces } = runtimes(env);
		const pathname = new URL(request.url).pathname;
		const route = routeFor(pathname);
		if (route === 'spaces') return spaces.fetch!(request, env, ctx);
		// Non-GET requests to the merged paths (CORS preflight, rejected methods)
		// belong to Contrail, which owns the public CORS policy.
		if (route === 'contrail' || request.method !== 'GET') {
			return contrail.fetch(request, env, ctx);
		}
		const [contrailResponse, spacesResponse] = await Promise.all([
			contrail.fetch(request, env, ctx),
			spaces.fetch!(request, env, ctx)
		]);
		return pathname === '/lexicons'
			? mergeLexiconBundles(contrailResponse, spacesResponse)
			: mergeDidDocuments(contrailResponse, spacesResponse);
	},

	/**
	 * Both halves run under one settled `waitUntil`. Each runtime's `scheduled`
	 * only schedules work, so capturing those promises keeps a failure in one
	 * half out of the other's way, and the Jetstream drain stays inside its
	 * configured slice. The Space reconcile slice self-bounds inside the package
	 * (25s deadline, five Spaces per tick).
	 */
	async scheduled(
		controller: ScheduledController,
		env: ApiEnv,
		ctx: ExecutionContext
	): Promise<void> {
		const { contrail, spaces } = runtimes(env);
		const pending: Promise<unknown>[] = [];
		// A capturing context: the runtime-supplied ExecutionContext carries more
		// members than a handler needs, and only waitUntil is exercised here.
		const capture = {
			waitUntil(promise: Promise<unknown>) {
				pending.push(promise);
			},
			passThroughOnException() {}
		} as unknown as ExecutionContext;
		await contrail.scheduled(controller as unknown as ScheduledEvent, env, capture);
		await spaces.scheduled!(controller, env, capture);
		ctx.waitUntil(Promise.allSettled(pending));
	},

	async queue(batch: SpacesQueueBatch, env: ApiEnv, ctx: ExecutionContext): Promise<void> {
		await runtimes(env).spaces.queue!(batch, env, ctx);
	}
};
