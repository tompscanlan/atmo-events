import { error } from '@sveltejs/kit';
import { command, getRequestEvent } from '$app/server';
import * as v from 'valibot';
import { callerSession } from '#lib/private-events/server/caller.js';
import { EVENT_PLACEMENTS } from './event-placement';
import { GROUP_EVENT_COLLECTION } from './ids';
import { requireGroupWriter, requireLinkedAbilities, requireStoredLink } from './server/context';
import { requireSettingsInBuild } from './server/enabled';
import {
	deleteMembersOnlyEvent,
	GroupEventRefused,
	putMembersOnlyEvent,
	refuseMembersOnlyKey,
	turnOnMembersOnly
} from './server/group-events';
import { notifyIndex, resolveGroup } from './server/group';
import { parseGroupSettings, saveGroupSettings as saveSettings } from './server/settings';
import { unlinkGroup } from './server/sign-in';
import { isLinkBroken, isRoleRefused, xrpc, xrpcBlob, XrpcError } from './server/xrpc';

const didSchema = v.pipe(v.string(), v.regex(/^did:[a-z]+:[a-zA-Z0-9._:%-]{1,2048}$/));
const rkeySchema = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9._:~-]{1,512}$/));
/** Public unless the page says members only. */
const placementSchema = v.optional(v.picklist(EVENT_PLACEMENTS), 'everyone');

function callerDid(): string | null {
	return getRequestEvent().locals.did;
}

const NO_ROLE = 'Your role in this group no longer allows that.';
const RELINK = 'Your link to this group stopped working. Link it again from its page.';
const NO_TURN_ON = "Your role in this group doesn't let you turn on members-only events.";

/** A refusal from the group's host, as a 403 whose words the page shows; any other failure is
 *  `outage`, a 502, which says nothing of what the host answered. */
function refusedOr(outage: string) {
	return (e: unknown): never => {
		if (isRoleRefused(e)) error(403, NO_ROLE);
		if (isLinkBroken(e)) error(403, RELINK);
		error(502, outage);
	};
}

const settingsSchema = v.object({
	name: v.string(),
	description: v.string(),
	website: v.string(),
	joinPolicy: v.string(),
	public: v.boolean()
});

/** `shownPublic` is the visibility the form showed, so a change made elsewhere since is kept. In a
 *  build without the settings page, the same 404 as groups off. */
export const saveGroupSettings = command(
	v.object({ groupDid: didSchema, shownPublic: v.boolean(), settings: settingsSchema }),
	async ({ groupDid, shownPublic, settings }) => {
		requireSettingsInBuild();
		const writer = await requireGroupWriter(groupDid, callerDid());
		const parsed = parseGroupSettings(settings);
		if (!parsed) {
			error(
				400,
				'Check the settings: a name is needed, up to 64 characters, and a website starts with https://.'
			);
		}
		const group = (await resolveGroup(groupDid)) ?? { did: groupDid, handle: null };
		try {
			await saveSettings(writer, group, parsed, shownPublic);
		} catch (e) {
			if (isRoleRefused(e)) error(403, NO_ROLE);
			if (isLinkBroken(e)) error(403, RELINK);
			if (e instanceof XrpcError && e.status === 400 && e.error === 'InvalidRequest') {
				error(400, 'The group host did not take these settings. Check them and try again.');
			}
			throw e;
		}
		return { ok: true };
	}
);

export const unlinkGroupSession = command(v.object({ groupDid: didSchema }), async (input) => {
	const did = await requireStoredLink(input.groupDid, callerDid());
	await unlinkGroup(input.groupDid, did);
	return { ok: true };
});

/** A refusal of a members-only write, in its own words, as a 409; anything else as `refusedOr`. */
function membersOnlyRefusedOr(outage: string) {
	const refused = refusedOr(outage);
	return (e: unknown): never => {
		if (e instanceof GroupEventRefused) error(409, e.message);
		return refused(e);
	};
}

export const putGroupEvent = command(
	v.object({
		groupDid: didSchema,
		rkey: rkeySchema,
		record: v.record(v.string(), v.unknown()),
		placement: placementSchema
	}),
	async ({ groupDid, rkey, record, placement }) => {
		const writer = await requireGroupWriter(groupDid, callerDid());
		if (placement === 'members') {
			// Into the group's calendar space: never the public repo, and nothing to the index.
			return putMembersOnlyEvent(writer, { rkey, record }).catch(
				membersOnlyRefusedOr('Saving the event failed')
			);
		}
		// A members-only event stays members-only: no public copy under its key.
		await refuseMembersOnlyKey(writer, rkey).catch(membersOnlyRefusedOr('Saving the event failed'));
		const result = await xrpc(writer.handle, 'com.atproto.repo.putRecord', {
			body: { repo: groupDid, collection: GROUP_EVENT_COLLECTION, rkey, record }
		}).catch(refusedOr('Saving the event failed'));
		const uri = String(result.uri);
		await notifyIndex(uri);
		return { uri, cid: String(result.cid) };
	}
);

export const deleteGroupEvent = command(
	v.object({ groupDid: didSchema, rkey: rkeySchema, placement: placementSchema }),
	async ({ groupDid, rkey, placement }) => {
		const writer = await requireGroupWriter(groupDid, callerDid());
		if (placement === 'members') {
			await deleteMembersOnlyEvent(writer, rkey).catch(refusedOr('Deleting the event failed'));
			return { ok: true };
		}
		await xrpc(writer.handle, 'com.atproto.repo.deleteRecord', {
			body: { repo: groupDid, collection: GROUP_EVENT_COLLECTION, rkey }
		}).catch(refusedOr('Deleting the event failed'));
		await notifyIndex(`at://${groupDid}/${GROUP_EVENT_COLLECTION}/${rkey}`);
		return { ok: true };
	}
);

/** Uses the calendar space the group already has for its members, or makes one. A link approved
 *  before there was one then needs approving once more before it may post there: the host gives a
 *  link no scope for a space that was not there at its approval. The person's own sign-in, beside
 *  the link, may read which calendars the group has. Only a link whose scope may make the calendar,
 *  as the page offers the control: choosing which calendar the group's members-only events go to
 *  is a change for the whole group, which the host does not check, since it is only reads and a
 *  note kept here. */
export const turnOnMembersOnlyEvents = command(
	v.object({ groupDid: didSchema }),
	async ({ groupDid }) => {
		const { writer, can } = await requireLinkedAbilities(groupDid, callerDid());
		if (!can.turnOnMembersOnly) error(403, NO_TURN_ON);
		const person = await callerSession(getRequestEvent().locals.session ?? null);
		await turnOnMembersOnly(writer, person ? [person] : []).catch((e) => {
			if (e instanceof XrpcError && e.status === 400) {
				error(409, "The group host didn't take the group's calendar. Nothing was turned on.");
			}
			return membersOnlyRefusedOr("Members-only events couldn't be turned on")(e);
		});
		return { ok: true };
	}
);

export const uploadGroupBlob = command(
	v.object({ groupDid: didSchema, bytes: v.array(v.number()), mimeType: v.string() }),
	async ({ groupDid, bytes, mimeType }) => {
		const writer = await requireGroupWriter(groupDid, callerDid());
		const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
		const result = await xrpcBlob(writer.handle, 'com.atproto.repo.uploadBlob', blob).catch(
			refusedOr('Upload failed')
		);
		return result.blob as { $type: 'blob'; ref: { $link: string }; mimeType: string; size: number };
	}
);
