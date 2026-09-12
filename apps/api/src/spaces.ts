/**
 * Members-only slice of an OpenMeet group.
 *
 * A group is a custodial PDS account. Its PUBLIC repo carries ordinary
 * `community.lexicon.calendar.*` records that anyone (and Contrail's public
 * index) can read; its `net.openmeet.group` Space carries the members-only
 * records. Spaces are never anonymously readable — not even under a `public`
 * policy — so this runtime is the only read path for that slice.
 *
 * Reads are earned, not assumed: a signed-in user hands the Worker a one-time
 * delegation token from the authority PDS, the Worker exchanges it for a
 * DPoP-bound Space credential, syncs the Space's repos, and projects the
 * records into Contrail's isolated tables. Roster, roles, and permissions stay
 * application rows; nothing here invents a membership Lexicon.
 */
import type { ContrailConfig } from '@atmo-dev/contrail';
import {
	createSpacesWorker,
	type SpacesWorkerHandler
} from '@atmo-dev/contrail-spaces-alpha/worker';
import { lexicons } from '../lexicons/generated';
import {
	isUnreachableServiceEndpoint,
	serviceAudience,
	SPACES_SERVICE_FRAGMENT
} from './service';

/** Host-side Space kind. Matches the live fixture; not a record Lexicon. */
export const GROUP_SPACE_TYPE = 'net.openmeet.group';
export const GROUP_EVENT_COLLECTION = 'community.lexicon.calendar.event';
export const GROUP_RSVP_COLLECTION = 'community.lexicon.calendar.rsvp';

/**
 * XRPC namespace of the Space provider methods. Deliberately distinct from the
 * public Contrail namespace (`rsvp.atmo`) so one prefix maps to exactly one
 * runtime and the dispatcher never has to guess.
 */
export const SPACES_NAMESPACE = GROUP_SPACE_TYPE;

export interface OpenmeetApiEnv {
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
 * service auth. No `subscriptions` option is passed, which is what keeps the
 * Durable Object out of the deployment (`subscriptionsEnabled` in the package's
 * worker.ts is `options.subscriptions !== undefined`).
 */
export function createGroupSpaces(endpoint: string): SpacesWorkerHandler<OpenmeetApiEnv> {
	return createSpacesWorker<OpenmeetApiEnv>({
		projection: spacesProjection,
		lexicons,
		standaloneUserApi: true,
		service: {
			endpoint,
			audience: serviceAudience(endpoint, SPACES_SERVICE_FRAGMENT)
		},
		spaceTypes: {
			[GROUP_SPACE_TYPE]: {
				// No `skey`: a group owns one Space per group account, keyed by the
				// group's own slug (the live fixture uses `kona`), not a literal.
				collections: [GROUP_EVENT_COLLECTION, GROUP_RSVP_COLLECTION],
				policy: 'member-list'
			}
		},
		// A user's read lease is short; reconciliation stays authoritative.
		accessLeaseMs: 15 * 60_000,
		reconcileIntervalMs: 5 * 60_000,
		// A dev origin is unreachable from the authority PDS, so push registration
		// would fail every cycle; scheduled reconcile stays authoritative.
		notificationRegistration: isUnreachableServiceEndpoint(endpoint)
			? 'disabled'
			: 'best-effort'
	});
}
