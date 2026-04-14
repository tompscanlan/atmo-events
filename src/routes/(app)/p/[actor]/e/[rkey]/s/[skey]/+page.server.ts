import type { PageServerLoad } from './$types';
import type { Did, ActorIdentifier } from '@atcute/lexicons';
import { getActor } from '$lib/actor';
import {
	flattenEventRecord,
	getProfileFromContrail,
	getProfileBlobUrl,
	getServerClient,
	type FlatEventRecord,
	type HostProfile
} from '$lib/contrail';
import { getPrivateSpace } from '$lib/spaces/server/spaces.remote';
import { SPACE_TYPE } from '$lib/spaces/config';

export const load: PageServerLoad = async ({ params, locals, platform, url }) => {
	const ownerDid = await getActor(params.actor);
	if (!ownerDid) {
		return { authState: 'not-found' as const };
	}

	if (!locals.did) {
		return { authState: 'anon' as const };
	}

	const spaceUri = `at://${ownerDid}/${SPACE_TYPE}/${params.skey}`;
	const hasInvite = url.searchParams.has('invite');

	const spaceResult = await getPrivateSpace({ spaceUri }).catch((e) => {
		console.error('[private-event-load] getPrivateSpace threw unexpectedly:', e);
		return { ok: false as const, status: 500 };
	});
	if (!spaceResult.ok) {
		if (hasInvite) return { authState: 'pending-invite' as const };
		return { authState: 'no-access' as const };
	}
	const spaceData = spaceResult;

	// Find the specific event this URL is for, not just the first one in the space.
	// Supports spaces that hold multiple events (future) without breaking existing
	// links when a space has a single event.
	const stored = spaceData.events.find((e) => e.rkey === params.rkey);
	if (!stored) {
		return { authState: 'no-access' as const };
	}

	const synthesizedRecord = {
		record: stored.record as Record<string, unknown>,
		cid: stored.cid ?? null,
		did: stored.authorDid,
		rkey: stored.rkey,
		uri: `at://${stored.authorDid}/${stored.collection}/${stored.rkey}`,
		space: spaceUri
	};
	const eventData = flattenEventRecord(synthesizedRecord as never) as FlatEventRecord | null;
	if (!eventData) {
		return { authState: 'no-access' as const };
	}

	const client = getServerClient(platform!.env.DB);
	let hostProfile: HostProfile | null = null;
	try {
		const p = await getProfileFromContrail(client, ownerDid as ActorIdentifier);
		if (p) {
			hostProfile = {
				did: p.did,
				handle: p.handle && p.handle !== 'handle.invalid' ? p.handle : ownerDid,
				displayName: p.record?.displayName,
				avatar: p.record?.avatar ? getProfileBlobUrl(p.did, p.record.avatar) : undefined
			};
		}
	} catch {
		// best-effort
	}

	const rsvps = (spaceData.rsvps ?? []) as Array<{
		authorDid: string;
		rkey: string;
		record: { status?: string; createdAt?: string; subject?: { uri?: string } };
	}>;
	const going: Array<{ did: string; rkey: string; createdAt?: string }> = [];
	const interested: Array<{ did: string; rkey: string; createdAt?: string }> = [];
	let viewerRsvpStatus: 'going' | 'interested' | 'notgoing' | null = null;
	let viewerRsvpRkey: string | null = null;

	for (const r of rsvps) {
		const statusFull = r.record?.status ?? '';
		const shortStatus = statusFull.split('#')[1] as 'going' | 'interested' | 'notgoing' | undefined;
		if (shortStatus === 'going')
			going.push({ did: r.authorDid, rkey: r.rkey, createdAt: r.record?.createdAt });
		else if (shortStatus === 'interested')
			interested.push({ did: r.authorDid, rkey: r.rkey, createdAt: r.record?.createdAt });
		if (r.authorDid === locals.did && shortStatus) {
			viewerRsvpStatus = shortStatus;
			viewerRsvpRkey = r.rkey;
		}
	}

	const attendeeDids = Array.from(new Set([...going, ...interested].map((a) => a.did)));
	const profileMap = new Map<string, HostProfile>();
	await Promise.all(
		attendeeDids.map(async (did) => {
			try {
				const p = await getProfileFromContrail(client, did as ActorIdentifier);
				if (p) {
					profileMap.set(did, {
						did: p.did,
						handle: p.handle && p.handle !== 'handle.invalid' ? p.handle : did,
						displayName: p.record?.displayName,
						avatar: p.record?.avatar ? getProfileBlobUrl(p.did, p.record.avatar) : undefined
					});
				}
			} catch {
				/* best-effort */
			}
		})
	);

	const shapeAttendee = (a: { did: string; rkey: string; createdAt?: string }) => {
		const p = profileMap.get(a.did);
		return {
			did: a.did,
			rkey: a.rkey,
			handle: p?.handle ?? a.did,
			displayName: p?.displayName,
			avatar: p?.avatar,
			createdAt: a.createdAt
		};
	};

	return {
		authState: 'member' as const,
		ownerDid: ownerDid as Did,
		spaceUri,
		spaceKey: params.skey,
		isOwner: ownerDid === locals.did,
		eventData,
		actorDid: ownerDid,
		rkey: params.rkey,
		hostProfile,
		attendees: {
			going: going.map(shapeAttendee),
			interested: interested.map(shapeAttendee),
			goingCount: going.length,
			interestedCount: interested.length
		},
		viewerRsvpStatus,
		viewerRsvpRkey,
		parentEvent: null,
		vod: null,
		speakerProfiles: [] as Array<{ id?: string; name: string; avatar?: string; handle?: string }>,
		ogImage: undefined as string | undefined
	};
};
