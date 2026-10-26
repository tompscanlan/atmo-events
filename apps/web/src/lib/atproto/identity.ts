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

// Each lookup gives up after `timeoutMs`: a network that drops traffic to outside hosts never
// answers a lookup of an outside handle, and the sign-in would otherwise wait for the
// connection to time out.
export function createHandleResolver(
	settings: NetworkSettings = network(),
	timeoutMs: number = HANDLE_LOOKUP_MS
): HandleResolver {
	const fetch = fetchWithin(timeoutMs);
	return new CompositeHandleResolver({
		methods: {
			dns: new DohJsonHandleResolver({ dohUrl: settings.dohUrl, fetch }),
			http: new WellKnownHandleResolver({ fetch })
		}
	});
}

// A plain controller and timer, since older browsers have no AbortSignal.any.
function fetchWithin(ms: number): typeof globalThis.fetch {
	return (input, init) => {
		const controller = new AbortController();
		const parent = init?.signal;
		if (parent?.aborted) controller.abort(parent.reason);
		parent?.addEventListener('abort', () => controller.abort(parent.reason), { once: true });
		setTimeout(
			() => controller.abort(new DOMException('The lookup timed out', 'TimeoutError')),
			ms
		);
		return globalThis.fetch(input, { ...init, signal: controller.signal });
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
