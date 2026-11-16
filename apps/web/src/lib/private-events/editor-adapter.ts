import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import {
	createInAppAdapter,
	handleOrDid,
	type EditorAdapter,
	type EditorViewer
} from '#lib/components/editor/adapter.js';
import { cancelPrivateEvent, savePrivateEvent } from './private-events.remote';

/** The in-app adapter, with every write sent to the event's space. It takes no image, since atmo
 *  can't show a private one yet, and nothing about it reaches the index. With `calendar`, the event
 *  goes on that shared calendar of the host's. */
export function createPrivateEventAdapter(viewer: EditorViewer, calendar?: string): EditorAdapter {
	const on = calendar ? { calendar } : {};
	return {
		...createInAppAdapter({ viewer }),
		// Those look up public records, which a private event doesn't link to for now.
		linkedRecords: undefined,
		features: { delete: true, recurring: false, images: false, visibility: false },
		async putRecord({ rkey, record }) {
			return savePrivateEvent({ rkey, record, ...on });
		},
		async createRecord({ rkey, record }) {
			if (!rkey) throw new Error('a private event needs its key');
			return savePrivateEvent({ rkey, record, ...on });
		},
		async deleteRecord({ rkey }) {
			await cancelPrivateEvent({ rkey, ...on });
		},
		async uploadBlob() {
			throw new Error('a private event takes no image');
		},
		onSaved({ rkey }) {
			const actor = handleOrDid(viewer);
			// The event its space was made for keeps its own address, on a calendar or not.
			goto(
				calendar && calendar !== rkey
					? resolve('/(app)/p/[actor]/calendar/[key]/[rkey]', { actor, key: calendar, rkey })
					: resolve('/(app)/p/[actor]/private/[rkey]', { actor, rkey }),
				{ refreshAll: true }
			);
		},
		onDeleted() {
			goto(
				calendar
					? resolve('/(app)/p/[actor]/calendar/[key]', {
							actor: handleOrDid(viewer),
							key: calendar
						})
					: resolve('/(app)'),
				{ refreshAll: true }
			);
		},
		async notifyUpdate() {}
	};
}
