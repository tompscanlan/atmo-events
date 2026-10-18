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

/** DID → document, from the deployment's directory for did:plc. */
export function createDidDocumentResolver(settings: NetworkSettings = network()) {
	return new CompositeDidDocumentResolver({
		methods: {
			plc: new PlcDidDocumentResolver(settings.plcUrl ? { apiUrl: settings.plcUrl } : undefined),
			web: new WebDidDocumentResolver()
		}
	});
}
