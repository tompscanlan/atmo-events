import {
	CompositeDidDocumentResolver,
	CompositeHandleResolver,
	DohJsonHandleResolver,
	PlcDidDocumentResolver,
	WebDidDocumentResolver,
	WellKnownHandleResolver,
	type HandleResolver
} from '@atcute/identity-resolver';
import { network, type NetworkSettings } from './network';

export const HANDLE_LOOKUP_MS = 5000;

// Each lookup gives up after `timeoutMs`: a sealed network never answers a lookup of an
// outside handle, and the sign-in would otherwise wait for the connection to time out.
export function createHandleResolver(
	settings: NetworkSettings = network(),
	timeoutMs: number = HANDLE_LOOKUP_MS
): HandleResolver {
	const fetch = fetchWithin(timeoutMs);
	const http = new WellKnownHandleResolver({ fetch });
	if (!settings.dohUrl) return http;
	return new CompositeHandleResolver({
		methods: { dns: new DohJsonHandleResolver({ dohUrl: settings.dohUrl, fetch }), http }
	});
}

function fetchWithin(ms: number): typeof globalThis.fetch {
	return (input, init) => {
		const limit = AbortSignal.timeout(ms);
		const signal = init?.signal ? AbortSignal.any([init.signal, limit]) : limit;
		return globalThis.fetch(input, { ...init, signal });
	};
}

export function createDidDocumentResolver(settings: NetworkSettings = network()) {
	return new CompositeDidDocumentResolver({
		methods: {
			plc: new PlcDidDocumentResolver(settings.plcUrl ? { apiUrl: settings.plcUrl } : {}),
			web: new WebDidDocumentResolver()
		}
	});
}
