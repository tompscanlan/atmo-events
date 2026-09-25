/**
 * Members-only slice of a group.
 *
 * A group is a custodial PDS account. Its public repo carries ordinary
 * `community.lexicon.calendar.*` records that anyone (and Contrail's public
 * index) can read. Its `net.openmeet.space.events` Space carries the
 * members-only records. A Space is never anonymously readable, not even under a
 * `public` policy, so this runtime is the only read path for that slice.
 *
 * To read, a signed-in user gives the Worker a one-time delegation token from
 * the authority PDS. The Worker exchanges it for a DPoP-bound Space credential,
 * syncs the Space's repos, and projects the records into Contrail's isolated
 * tables.
 */
import type { ContrailConfig } from '@atmo-dev/contrail';
import {
	createSpacesWorker,
	type SpacesWorkerHandler
} from '@atmo-dev/contrail-spaces-alpha/worker';
import { lexicons } from '../lexicons/generated';
import { isUnreachableServiceEndpoint, serviceAudience, SPACES_SERVICE_FRAGMENT } from './service';

/** Host-side Space kind of the group's members-only EVENTS container: events
 *  and RSVPs under the member-list read policy. The web app owns the group's
 *  other two types (`net.openmeet.space.about`, `.members`); all three sit
 *  under the `space` segment so that no space type is also an XRPC prefix.
 *  Not a record Lexicon. */
export const EVENTS_SPACE_TYPE = 'net.openmeet.space.events';
/** Every group space is keyed `self`, so its URI follows from the group DID
 *  and the type alone. */
export const EVENTS_SPACE_SKEY = 'self';
export const GROUP_EVENT_COLLECTION = 'community.lexicon.calendar.event';
export const GROUP_RSVP_COLLECTION = 'community.lexicon.calendar.rsvp';

/**
 * XRPC namespace of the Space provider methods: verbs, where the group's record
 * collections are nouns under the same prefix. Deliberately distinct from the
 * public Contrail namespace (`rsvp.atmo`) so one prefix maps to exactly one
 * runtime and the dispatcher never has to guess, and distinct from every space
 * type so one NSID never does two jobs.
 */
export const SPACES_NAMESPACE = 'net.openmeet.group';

export interface ApiEnv {
	[key: string]: unknown;
	DB: D1Database;
	SPACES_QUEUE?: Queue;
	SPACES_CREDENTIAL_ENCRYPTION_KEY: string;
	PUBLIC_SERVICE_ENDPOINT?: string;
}

/**
 * Private projection for Space records. Separate from `contrail.config.ts` on
 * purpose: the public index keeps its permissive posture, while every Space
 * collection must enable Lexicon and CID validation (`createSpacesWorker`
 * throws `Space collection <nsid> must enable Lexicon and CID validation`
 * otherwise), because these records arrive over a verified repo sync rather
 * than a firehose we already trust.
 */
export const spacesProjection: ContrailConfig = {
	namespace: SPACES_NAMESPACE,
	profiles: [],
	collections: {
		event: {
			collection: GROUP_EVENT_COLLECTION,
			validate: true,
			searchable: ['name', 'description'],
			queryable: {
				mode: {},
				name: {},
				status: {},
				startsAt: { type: 'range' },
				endsAt: { type: 'range' },
				createdAt: { type: 'range' }
			},
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
			}
		},
		rsvp: {
			collection: GROUP_RSVP_COLLECTION,
			validate: true,
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
		}
	},
	validation: { verifyCid: true, strict: true },
	constellation: false
};

/**
 * Build the Space provider for one serving origin.
 *
 * `standaloneUserApi` is on because this Worker is a standalone API: the web
 * app owns OAuth and reaches these methods over exact, method-bound AT Protocol
 * service auth. No `subscriptions` option is passed: the package enables
 * subscriptions only when that option is set, so the deployment needs no
 * Durable Object.
 */
export function createGroupSpaces(endpoint: string): SpacesWorkerHandler<ApiEnv> {
	return createSpacesWorker<ApiEnv>({
		projection: spacesProjection,
		lexicons,
		standaloneUserApi: true,
		service: {
			endpoint,
			audience: serviceAudience(endpoint, SPACES_SERVICE_FRAGMENT)
		},
		spaceTypes: {
			[EVENTS_SPACE_TYPE]: {
				skey: EVENTS_SPACE_SKEY,
				collections: [GROUP_EVENT_COLLECTION, GROUP_RSVP_COLLECTION],
				readPolicy: 'member-list',
				writePolicy: 'member-list'
			}
		},
		// A user's read lease is short; reconciliation stays authoritative.
		accessLeaseMs: 15 * 60_000,
		reconcileIntervalMs: 5 * 60_000,
		// A dev origin is unreachable from the authority PDS, so push registration
		// would fail every cycle; scheduled reconcile stays authoritative.
		notificationRegistration: isUnreachableServiceEndpoint(endpoint) ? 'disabled' : 'best-effort'
	});
}
