import { getActor } from '$lib/actor';
import {
	flattenEventRecords,
	getProfileFromContrail,
	getServerClient,
	listAttendingEventsFromContrail,
	listAuthoredEventsFromContrail
} from '$lib/contrail';
import { getSpacesClient } from '$lib/spaces/server/client';
import { spacesAvailable } from '$lib/spaces/config';
import { isActorIdentifier } from '@atcute/lexicons/syntax';
import { error, fail } from '@sveltejs/kit';
import { parseAuthorityRegistry } from '$lib/community/server/authority-registry';
import {
	canManagePublishers,
	detectCommunity,
	getCallerRole,
	grantPublisher,
	hydratePublisherProfiles,
	listPublishers,
	publishersSpaceUri,
	revokePublisher
} from '$lib/community/server/membership';
import type { AccessLevel, PublisherMember } from '$lib/community/server/membership';

const PREVIEW_LIMIT = 6;

export async function load({ params, platform, locals, fetch }) {
	// Authenticated viewer + spaces configured → service-auth client so contrail
	// unions public events with private events from spaces the viewer is in.
	// Profile pages show another user's events; the viewer only sees the private
	// ones where *they* are a member (filtered server-side by caller DID).
	const client =
		locals.client && locals.did && spacesAvailable()
			? getSpacesClient(locals.client, platform!.env.DB)
			: getServerClient(platform!.env.DB);
	// `listAuthored` is a public pipelineQuery, not a declared lexicon method, so
	// the service-auth spaces client can't mint a JWT for it (the PDS 403s). Route
	// the public event listings through the in-process server client instead —
	// matching the hosting/past-events pages, which already use it.
	const publicClient = getServerClient(platform!.env.DB);
	if (!isActorIdentifier(params.actor)) return;

	const actor = params.actor;
	const did = await getActor(actor);

	if (!did) throw error(404, 'Actor not found');

	const registry = parseAuthorityRegistry(platform?.env.COMMUNITY_AUTHORITIES);
	const communityAuthority = await detectCommunity(did, registry).catch(() => null);
	const isCommunity = !!communityAuthority;
	const communitySpaceUri = isCommunity ? publishersSpaceUri(did) : null;
	const now = new Date().toISOString();

	const [profile, upcomingResponse, pastResponse, attendingEvents] = await Promise.all([
		getProfileFromContrail(client, actor),
		listAuthoredEventsFromContrail(publicClient, {
			hydrateRsvps: 5,
			profiles: true,
			sort: 'startsAt',
			order: 'asc',
			startsAtMin: now,
			actor,
			limit: PREVIEW_LIMIT + 1
		}),
		listAuthoredEventsFromContrail(publicClient, {
			hydrateRsvps: 5,
			profiles: true,
			sort: 'startsAt',
			order: 'desc',
			startsAtMax: now,
			actor,
			limit: PREVIEW_LIMIT + 1
		}),
		isCommunity ? Promise.resolve([]) : listAttendingEventsFromContrail(client, actor)
	]);

	const nowDate = new Date(now);
	const upcomingEvents = upcomingResponse ? flattenEventRecords(upcomingResponse.records) : [];
	const pastEvents = (pastResponse ? flattenEventRecords(pastResponse.records) : []).filter(
		(e) => new Date(e.endsAt || e.startsAt) < nowDate
	);

	let callerRole: AccessLevel | null = null;
	let members: PublisherMember[] = [];
	let membershipError: string | null = null;

	if (communityAuthority && communitySpaceUri && locals.client) {
		const communityCtx = {
			fetch,
			oauthClient: locals.client,
			authority: communityAuthority,
			spaceUri: communitySpaceUri
		};
		try {
			const [role, publisherRows] = await Promise.all([
				locals.did ? getCallerRole(communityCtx) : Promise.resolve(null),
				listPublishers(communityCtx)
			]);
			callerRole = role;
			members = await hydratePublisherProfiles(client, publisherRows);
		} catch (err) {
			console.warn('[profile community] membership fetch failed', err);
			membershipError = 'Membership is temporarily unavailable.';
		}
	}

	return {
		upcomingEvents: upcomingEvents.slice(0, PREVIEW_LIMIT),
		hasMoreUpcoming: upcomingEvents.length > PREVIEW_LIMIT,
		pastEvents: pastEvents.slice(0, PREVIEW_LIMIT),
		hasMorePast: pastEvents.length > PREVIEW_LIMIT,
		attendingEvents,
		actorProfile: profile,
		actor,
		actorDid: did,
		community: {
			isCommunity,
			authorityEndpoint: communityAuthority?.endpoint ?? null,
			publishersSpaceUri: communitySpaceUri,
			callerRole,
			canManage: canManagePublishers(callerRole),
			members,
			membershipError
		}
	};
}

async function getCommunityActionContext({
	params,
	platform,
	locals,
	fetch
}: {
	params: { actor: string };
	platform?: App.Platform;
	locals: App.Locals;
	fetch: typeof globalThis.fetch;
}) {
	if (!locals.client) throw error(401, 'Not authenticated');
	const actorDid = await getActor(params.actor);
	if (!actorDid) throw error(404, 'Actor not found');
	const registry = parseAuthorityRegistry(platform?.env.COMMUNITY_AUTHORITIES);
	const authority = await detectCommunity(actorDid, registry);
	if (!authority) throw error(404, 'Community not found');
	return {
		fetch,
		oauthClient: locals.client,
		authority,
		spaceUri: publishersSpaceUri(actorDid)
	};
}

export const actions = {
	grantPublisher: async ({ request, params, platform, locals, fetch }) => {
		const form = await request.formData();
		const actor = String(form.get('actor') ?? '').trim();
		if (!actor) return fail(400, { message: 'Enter a handle or DID.' });

		try {
			const ctx = await getCommunityActionContext({ params, platform, locals, fetch });
			await grantPublisher(ctx, actor);
			return { ok: true };
		} catch (err) {
			console.warn('[profile community] grant failed', err);
			const message = err instanceof Error ? err.message : 'Could not add publisher.';
			const status =
				typeof (err as { status?: unknown }).status === 'number'
					? (err as { status: number }).status
					: 400;
			return fail(status >= 400 && status < 500 ? status : 400, { message });
		}
	},
	revokePublisher: async ({ request, params, platform, locals, fetch }) => {
		const form = await request.formData();
		const did = String(form.get('did') ?? '').trim();
		if (!did) return fail(400, { message: 'Missing member DID.' });

		try {
			const ctx = await getCommunityActionContext({ params, platform, locals, fetch });
			await revokePublisher(ctx, did);
			return { ok: true };
		} catch (err) {
			console.warn('[profile community] revoke failed', err);
			const message = err instanceof Error ? err.message : 'Could not remove publisher.';
			const status =
				typeof (err as { status?: unknown }).status === 'number'
					? (err as { status: number }).status
					: 400;
			return fail(status >= 400 && status < 500 ? status : 400, { message });
		}
	}
};
