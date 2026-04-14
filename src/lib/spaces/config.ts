import type { SpacesConfig } from '@atmo-dev/contrail';
import {
	CompositeDidDocumentResolver,
	PlcDidDocumentResolver,
	WebDidDocumentResolver
} from '@atcute/identity-resolver';
import { SERVICE_DID, SERVICE_URL } from './tunnel-service.generated';

/** The NSID identifying our kind of permissioned space. */
export const SPACE_TYPE = 'tools.atmo.event.space';

/** Per-collection policy for event-space records. */
const DEFAULT_POLICIES = {
	'community.lexicon.calendar.event': { read: 'member' as const, write: 'owner' as const },
	'community.lexicon.calendar.rsvp': { read: 'member' as const, write: 'member' as const },
	'app.event.message': { read: 'member' as const, write: 'member' as const }
};

/** Build the spaces config for contrail, or null if we can't run spaces
 *  (no service DID => dev without tunnel, prod before service is published). */
export function getSpacesConfig(): SpacesConfig | null {
	if (!SERVICE_DID) {
		return null;
	}
	return {
		type: SPACE_TYPE,
		serviceDid: SERVICE_DID,
		resolver: new CompositeDidDocumentResolver({
			methods: {
				plc: new PlcDidDocumentResolver(),
				web: new WebDidDocumentResolver()
			}
		}),
		defaultPolicies: DEFAULT_POLICIES
	};
}

/** True if spaces are available in this environment. */
export function spacesAvailable(): boolean {
	return SERVICE_DID != null;
}

export { SERVICE_DID, SERVICE_URL };
