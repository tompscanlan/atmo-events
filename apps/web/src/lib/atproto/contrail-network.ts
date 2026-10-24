import type { ContrailConfig } from '@atmo-dev/contrail';
import { createDidDocumentResolver } from './identity';
import type { NetworkSettings } from './network';

// Contrail adds `?identifier=` to the URL it is given, so it takes the method's URL: given
// the service's root, every lookup gets Slingshot's home page and fails quietly.
const RESOLVE_MINI_DOC = '/xrpc/com.bad-example.identity.resolveMiniDoc';

export function contrailNetwork(
	settings: NetworkSettings
): Pick<ContrailConfig, 'jetstreams' | 'relays' | 'constellation' | 'networkOverrides'> {
	const networkOverrides: NonNullable<ContrailConfig['networkOverrides']> = {};
	if (settings.slingshotUrl) {
		networkOverrides.slingshotUrl = settings.slingshotUrl.replace(/\/+$/, '') + RESOLVE_MINI_DOC;
	}
	if (settings.plcUrl) networkOverrides.resolver = createDidDocumentResolver(settings);

	return {
		...(settings.jetstreams ? { jetstreams: settings.jetstreams } : {}),
		...(settings.relays ? { relays: settings.relays } : {}),
		...(settings.constellationUrl === null
			? { constellation: false as const }
			: settings.constellationUrl
				? { constellation: { url: settings.constellationUrl } }
				: {}),
		...(Object.keys(networkOverrides).length ? { networkOverrides } : {})
	};
}
