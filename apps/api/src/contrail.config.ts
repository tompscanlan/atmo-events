import type { ContrailConfig } from '@atmo-dev/contrail';
import { listAuthored, listDiscoverable, listDiscoverableByUris, listTalks } from './queries';
import {
	CONTRAIL_SERVICE_FRAGMENT,
	DEFAULT_PUBLIC_SERVICE_ENDPOINT,
	serviceAudience
} from './service';

export const config: ContrailConfig = {
	namespace: 'rsvp.atmo',
	profiles: ['app.bsky.actor.profile'],
	jetstreams: ['wss://jetstream1.us-east.bsky.network'],
	orderedSource: {
		source: 'jetstream',
		epoch: 'openmeet-atmo-api-primary-2026-09'
	},
	notify: true,
	serviceAuth: {
		// Rebound per serving origin by contrailConfigFor; this default keeps the
		// checked-in config self-consistent with DEFAULT_PUBLIC_SERVICE_ENDPOINT.
		audience: serviceAudience(DEFAULT_PUBLIC_SERVICE_ENDPOINT, CONTRAIL_SERVICE_FRAGMENT),
		methods: ['getFeed', 'notifyOfUpdate']
	},
	maintenance: { optimize: true },
	collections: {
		event: {
			collection: 'community.lexicon.calendar.event',
			queryable: {
				mode: {},
				name: {},
				status: {},
				description: {},
				'preferences.showInDiscovery': {},
				startsAt: { type: 'range' },
				endsAt: { type: 'range' },
				createdAt: { type: 'range' }
			},
			searchable: ['mode', 'name', 'status', 'description'],
			relations: {
				rsvps: {
					collection: 'rsvp',
					groupBy: 'status',
					groups: {
						going: 'community.lexicon.calendar.rsvp#going',
						interested: 'community.lexicon.calendar.rsvp#interested',
						notgoing: 'community.lexicon.calendar.rsvp#notgoing'
					}
				}
			},
			pipelineQueries: {
				listDiscoverable,
				listDiscoverableByUris,
				listTalks,
				listAuthored
			}
		},
		rsvp: {
			collection: 'community.lexicon.calendar.rsvp',
			queryable: {
				status: {},
				'subject.uri': {},
				createdAt: { type: 'range' }
			},
			references: {
				event: {
					collection: 'event',
					field: 'subject.uri'
				}
			}
		},
		profile: {
			collection: 'app.bsky.actor.profile',
			discover: false,
			methods: []
		},
		follow: {
			collection: 'app.bsky.graph.follow',
			discover: false,
			subjectField: 'subject',
			methods: []
		}
	},
	feeds: {
		network: {
			targets: [
				{ collection: 'event', maxItems: 100 },
				{ collection: 'rsvp', maxItems: 250 }
			]
		}
	}
};

/**
 * The public config as served from one origin. Contrail only publishes
 * `/.well-known/did.json` when the service audience resolves its DID document
 * back to the serving origin, so the audience follows the endpoint.
 */
export function contrailConfigFor(endpoint: string): ContrailConfig {
	return {
		...config,
		serviceAuth: {
			...config.serviceAuth!,
			audience: serviceAudience(endpoint, CONTRAIL_SERVICE_FRAGMENT)
		}
	};
}
