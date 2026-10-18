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

/**
 * Handle → DID. DNS (over HTTPS) and `.well-known` race, unless the deployment
 * has no DNS resolver (see ./network), when it is `.well-known` alone.
 */
export function createHandleResolver(settings: NetworkSettings = network()): HandleResolver {
	const http = new WellKnownHandleResolver();
	if (!settings.dohUrl) return http;
	return new CompositeHandleResolver({
		methods: { dns: new DohJsonHandleResolver({ dohUrl: settings.dohUrl }), http }
	});
}

/**
 * DID → document, from the deployment's directory for did:plc. `fetch` is for a
 * caller that must reach the global `fetch` as it is when the resolver runs.
 */
export function createDidDocumentResolver(
	settings: NetworkSettings = network(),
	fetch?: typeof globalThis.fetch
) {
	return new CompositeDidDocumentResolver({
		methods: {
			plc: new PlcDidDocumentResolver({
				...(settings.plcUrl ? { apiUrl: settings.plcUrl } : {}),
				...(fetch ? { fetch } : {})
			}),
			web: new WebDidDocumentResolver(fetch ? { fetch } : undefined)
		}
	});
}
