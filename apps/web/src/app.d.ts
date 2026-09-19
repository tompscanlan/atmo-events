// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { OAuthSession } from '@atcute/oauth-node-client';
import type { Client } from '@atcute/client';
import type { Did } from '@atcute/lexicons';

interface BlentoSession {
	did: string;
	handle?: string;
	displayName?: string;
	avatar?: string;
}

interface BlentoBlobRef {
	$type: 'blob';
	ref: { $link: string };
	mimeType: string;
	size: number;
}

type BlentoWrite =
	| { $type: 'create'; collection: string; rkey?: string; value: Record<string, unknown> }
	| { $type: 'update'; collection: string; rkey: string; value: Record<string, unknown> }
	| { $type: 'delete'; collection: string; rkey: string };

interface Blento {
	ready: Promise<void>;
	getTheme(): { base: string | null; accent: string | null; dark: boolean };
	getSession(): BlentoSession | null;
	on(event: 'session', cb: (session: BlentoSession | null) => void): () => void;
	createRecord(opts: {
		collection: string;
		rkey?: string;
		record: Record<string, unknown>;
	}): Promise<{ uri: string; cid?: string }>;
	putRecord(opts: {
		collection: string;
		rkey: string;
		record: Record<string, unknown>;
	}): Promise<{ uri: string; cid?: string }>;
	deleteRecord(opts: { collection: string; rkey: string }): Promise<{ ok: boolean }>;
	applyWrites(opts: {
		writes: BlentoWrite[];
		validate?: boolean;
	}): Promise<{ results: Array<{ uri?: string; cid?: string }> }>;
	uploadBlob(blob: Blob, opts?: { mimeType?: string }): Promise<BlentoBlobRef>;
	notifyResize(heightPx: number): void;
	notifyNavigate(url: string): void;
	promptLogin(): void;
	notify(name: string, payload?: unknown): void;
}

declare global {
	interface Window {
		Blento?: Blento;
	}
	namespace App {
		// interface Error {}
		interface Locals {
			session: OAuthSession | null;
			client: Client | null;
			did: Did | null;
		}
		// interface PageData {}
		// interface PageState {}
		interface Platform {
			env: {
				OAUTH_SESSIONS: KVNamespace;
				OAUTH_STATES: KVNamespace;
				CLIENT_ASSERTION_KEY: string;
				COOKIE_SECRET: string;
				OAUTH_PUBLIC_URL: string;
				DB: D1Database;
				CRON_SECRET: string;
				/** Meilisearch base url for the search read path (search/near-me).
				 *  When either var is unset, search falls back to the D1 path and
				 *  near-me is unavailable. */
				SEARCH_URL?: string;
				/** Read-only Default Search API Key (set via `wrangler secret put`).
				 *  Never the admin or root key. */
				SEARCH_API_KEY?: string;
				/** Search index uid; defaults to `events`. Shared by the read path
				 *  and the write sink (one index, written and read), so there is no
				 *  separate write-side index var. */
				SEARCH_INDEX?: string;
				/** Meilisearch base url for the WRITE path (the search sink). Kept
				 *  distinct from SEARCH_URL so the writer can use the admin key while
				 *  the read path stays on the search-only key. When unset, the cron
				 *  ingest runs without feeding search (D1 fallback still serves). */
				SEARCH_SINK_URL?: string;
				/** Default Admin API Key for the write path (set via
				 *  `wrangler secret put`). Never the instance root key. */
				SEARCH_SINK_API_KEY?: string;
				/** Forward-geocoder endpoint for the address→_geo drip (the cron job
				 *  that resolves coordinates for newly-ingested address-only events).
				 *  Nominatim-compatible /search; LocationIQ = `https://us1.locationiq.com/v1/search`.
				 *  Reuses the SEARCH_SINK_* Meili write creds + the DB binding, so this
				 *  plus GEOCODER_KEY are the only drip-specific config. */
				GEOCODER_URL?: string;
				/** Geocoder API key (LocationIQ), set via `wrangler secret put`. When
				 *  unset, the drip no-ops (it won't fall back to public Nominatim). */
				GEOCODER_KEY?: string;
				/** Optional User-Agent for geocoder requests. */
				GEOCODER_USER_AGENT?: string;
				/** Min ms between geocoder calls in the drip — the rate limiter. Set to
				 *  the ceiling the geocoder tier allows; defaults to DEFAULT_GEOCODE_SLEEP_MS. */
				GEOCODE_SLEEP_MS?: string;
				/** PDS every new group is minted on, e.g. https://pds.opnmt.net. With
				 *  the three vars below it forms the mint target; when any is unset
				 *  /groups/create refuses BEFORE minting rather than stranding a
				 *  permanent did:plc it cannot finish setting up. */
				GROUP_PDS_SERVICE?: string;
				/** Handle suffix for groups, e.g. group.opnmt.net. Groups get their
				 *  OWN subdomain so a group handle can never lose a race to a member
				 *  handle: members get accounts on the same PDS (om-kp7ss.5), and one
				 *  flat registry would let a person's name decide whether a group can
				 *  be created. (Spec: FR-001b.) */
				GROUP_HANDLE_DOMAIN?: string;
				/** Invite code for the group PDS, set with `wrangler secret put`.
				 *  PDS_INVITE_REQUIRED is true on the alpha, so we hold a code rather
				 *  than opening the gate. The 1000-use budget is SHARED with member
				 *  accounts and a deleted account never returns its use. */
				GROUP_PDS_INVITE_CODE?: string;
				/** Address group accounts are created with, e.g.
				 *  groups@openmeet.net — plus-addressed per group
				 *  (groups+<slug>@…) because the PDS requires an email, refuses
				 *  disposable domains, and matches it exactly for uniqueness. Ours
				 *  rather than the owner's, so the password-reset path stays ours.
				 *  (Spec: FR-001h.) */
				GROUP_ACCOUNT_EMAIL?: string;
				/** base64 32-byte AES-GCM key wrapping every minted group's app
				 *  password in `group_credentials`. Set with `wrangler secret put`.
				 *  Without it a minted credential can be neither written nor read, so
				 *  the create flow refuses up front. Losing it costs the stored
				 *  credentials (recoverable via PDS admin), never the groups'
				 *  identities — the owner holds rotationKeys[0]. */
				GROUP_CREDENTIAL_KEY?: string;
			};
			/** Cloudflare Worker execution context. Use `ctx.waitUntil(promise)` to
			 *  let the worker keep a fire-and-forget task alive after the response
			 *  has been sent. Optional in dev (wrangler proxy may not provide it). */
			ctx?: { waitUntil(promise: Promise<unknown>): void };
		}
	}
}
import type {} from '@atcute/atproto';
import type {} from '@atcute/bluesky';

export {};
