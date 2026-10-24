import type { ContrailConfig } from '@atmo-dev/contrail';
import { createDidDocumentResolver } from './identity';
import type { NetworkSettings } from './network';

/** The Slingshot method contrail calls. Contrail takes the method's own URL, not
 *  the service's, and adds `?identifier=` to it; given the service's root, every
 *  lookup gets Slingshot's home page, fails quietly, and leaves the handle unset. */
const RESOLVE_MINI_DOC = '/xrpc/com.bad-example.identity.resolveMiniDoc';

/**
 * The parts of contrail's config that name a network address, from the
 * deployment's settings. A setting that is unset leaves contrail's own default
 * (the public service) in place.
 */
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
