import { error } from '@sveltejs/kit';
import { command, getRequestEvent } from '$app/server';
import * as v from 'valibot';
import { EVENT_PLACEMENTS } from './event-placement';
import { requireGroupWriter } from './server/context';
import { finishSetup, pendingSetup } from './server/create';
import { listGroup, readGroupMeta, resolveGroup, unlistGroup } from './server/group';
import { deleteGroupEvent, GroupEventRefused, putGroupEvent } from './server/group-events';
import { applyGroupSettings, parseGroupSettings } from './server/settings';
import { unlinkGroup } from './server/sign-in';
import { xrpc } from './server/xrpc';

const didSchema = v.pipe(v.string(), v.regex(/^did:[a-z]+:[a-zA-Z0-9._:%-]{1,2048}$/));
const rkeySchema = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9._:~-]{1,512}$/));
/** Required: a put creates a record that is not there, so a write without it could make a
 *  public copy of a members-only event. */
const placementSchema = v.picklist(EVENT_PLACEMENTS);

/** A refusal in its own words; any other failure as `failed`. */
function eventWriteFailed(failed: string) {
	return (e: unknown): never => {
		if (e instanceof GroupEventRefused) error(409, e.message);
		console.error(`[groups] ${failed}:`, e);
		error(502, failed);
	};
}

function callerDid(): string | null {
	return getRequestEvent().locals.did;
}

/** Lists only a public group, as the proposal publishes a declaration only then. */
export const setGroupListed = command(
	v.object({ groupDid: didSchema, listed: v.boolean() }),
	async ({ groupDid, listed }) => {
		const writer = await requireGroupWriter(groupDid, callerDid());
		if (listed) {
			const meta = await readGroupMeta(writer.handle, groupDid);
			if (!meta.public) error(409, 'Only a public group can be listed');
			await listGroup(writer.handle, groupDid);
		} else {
			await unlistGroup(writer.handle, groupDid);
		}
		return { listed };
	}
);

export const unlinkGroupSession = command(v.object({ groupDid: didSchema }), async (input) => {
	const did = callerDid();
	await requireGroupWriter(input.groupDid, did);
	await unlinkGroup(input.groupDid, did as string);
	return { ok: true };
});

export const saveGroupEvent = command(
	v.object({
		groupDid: didSchema,
		rkey: rkeySchema,
		record: v.record(v.string(), v.unknown()),
		placement: placementSchema
	}),
	async ({ groupDid, ...input }) => {
		const writer = await requireGroupWriter(groupDid, callerDid());
		return putGroupEvent(writer, input).catch(eventWriteFailed('Saving the event failed'));
	}
);

export const removeGroupEvent = command(
	v.object({ groupDid: didSchema, rkey: rkeySchema, placement: placementSchema }),
	async ({ groupDid, ...input }) => {
		const writer = await requireGroupWriter(groupDid, callerDid());
		await deleteGroupEvent(writer, input).catch(eventWriteFailed('Deleting the event failed'));
		return { ok: true };
	}
);

export const uploadGroupBlob = command(
	v.object({ groupDid: didSchema, bytes: v.array(v.number()), mimeType: v.string() }),
	async ({ groupDid, bytes, mimeType }) => {
		const writer = await requireGroupWriter(groupDid, callerDid());
		const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
		const result = await xrpc(writer.handle, 'com.atproto.repo.uploadBlob', { blob }).catch(() =>
			error(502, 'Upload failed')
		);
		return result.blob as { $type: 'blob'; ref: { $link: string }; mimeType: string; size: number };
	}
);

export const saveGroupSettings = command(
	v.object({
		groupDid: didSchema,
		settings: v.record(v.string(), v.unknown()),
		shownPublic: v.boolean()
	}),
	async ({ groupDid, settings, shownPublic }) => {
		const parsed = parseGroupSettings(settings);
		if (!parsed) error(400, 'A name is needed, up to 64 characters');
		const writer = await requireGroupWriter(groupDid, callerDid());
		const group = (await resolveGroup(groupDid)) ?? { did: groupDid, handle: null };
		await applyGroupSettings(writer, group, parsed, shownPublic).catch(() =>
			error(502, 'The save stopped partway. Saving again finishes it.')
		);
		return { ok: true };
	}
);

/** For the creator of a group whose setup stopped: the rest of it. */
export const finishGroupSetup = command(v.object({ groupDid: didSchema }), async ({ groupDid }) => {
	const did = callerDid();
	const writer = await requireGroupWriter(groupDid, did);
	const setup = await pendingSetup(groupDid);
	if (!setup || setup.by !== did) error(404, 'Nothing is left to set up');
	const group = (await resolveGroup(groupDid)) ?? { did: groupDid, handle: null };
	await finishSetup(writer, group, setup).catch(() =>
		error(502, 'Setting up stopped again. Try once more shortly.')
	);
	return { ok: true };
});
