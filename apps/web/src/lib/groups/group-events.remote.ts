// Group events, written as the group, as remote commands.
import { command } from '$app/server';
import * as v from 'valibot';
import type { GroupFormResult } from './form-result';
import { formError } from './form-error';
import { didField, eventIntentField, placementField, rkeyField } from './form-fields';
import { groupRequestContext } from './remote-context';
import {
	GROUP_EVENT_IMAGE_MAX_BYTES,
	deleteGroupEvent,
	uploadGroupEventImage,
	writeGroupEvent,
	type GroupBlobRef
} from './server/event-writer';

// The group's side of atmo's event editor (./editor-adapter.ts). The editor
// builds the record; these write it as the group. The writer checks the
// permission from a fresh membership read (CREATE_EVENT for a create,
// MANAGE_EVENTS otherwise) and the record against the event lexicon.
//
// Both take the event's placement, `everyone` or `members`, never optional, so a
// page that forgets it gets a validation error rather than a public post. The
// writer turns `members` into the group's own calendar space. (Spec: FR-116.)

/** Create or edit a group event, authored by the group DID. */
export const putGroupEvent = command(
	v.object({
		groupDid: didField,
		rkey: rkeyField,
		intent: eventIntentField,
		placement: placementField,
		record: v.record(v.string(), v.unknown())
	}),
	async (data): Promise<GroupFormResult<{ uri: string }>> => {
		const { db, env, group, callerDid, reader } = await groupRequestContext(data.groupDid);
		try {
			const result = await writeGroupEvent({
				db,
				env,
				group,
				callerDid,
				reader,
				intent: data.intent,
				rkey: data.rkey,
				placement: data.placement,
				record: data.record
			});
			return { ok: true, uri: result.uri };
		} catch (e) {
			return formError(e);
		}
	}
);

export const removeGroupEvent = command(
	v.object({ groupDid: didField, rkey: rkeyField, placement: placementField }),
	async (data): Promise<GroupFormResult<{ uri: string }>> => {
		const { db, env, group, callerDid, reader } = await groupRequestContext(data.groupDid);
		try {
			const result = await deleteGroupEvent({
				db,
				env,
				group,
				callerDid,
				reader,
				rkey: data.rkey,
				placement: data.placement
			});
			return { ok: true, uri: result.uri };
		} catch (e) {
			return formError(e);
		}
	}
);

/** An event's cover image, uploaded into the group's repo so the group's
 *  record can cite it. Bytes as a number array, as atmo's own upload sends them. */
export const putGroupEventImage = command(
	v.object({
		groupDid: didField,
		intent: eventIntentField,
		bytes: v.pipe(v.array(v.number()), v.maxLength(GROUP_EVENT_IMAGE_MAX_BYTES)),
		mimeType: v.pipe(v.string(), v.maxLength(100))
	}),
	async (data): Promise<GroupFormResult<{ blob: GroupBlobRef }>> => {
		const { db, env, group, callerDid, reader } = await groupRequestContext(data.groupDid);
		try {
			const blob = await uploadGroupEventImage({
				db,
				env,
				group,
				callerDid,
				reader,
				intent: data.intent,
				bytes: new Uint8Array(data.bytes),
				mimeType: data.mimeType
			});
			return { ok: true, blob };
		} catch (e) {
			return formError(e);
		}
	}
);
