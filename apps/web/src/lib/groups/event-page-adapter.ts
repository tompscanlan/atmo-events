// The adapter a members-only event's page hands the shared EventView. The page
// shows the event and writes nothing.
//
// It has no space write. EventView's RSVP button writes into the event's space
// only through the adapter's space methods, and when it has a space but no such
// method it logs and stops: nothing is written, and nothing falls back to a
// public RSVP, which would publish the event's URI and who is going. So the
// button does nothing until members-only RSVPs land. The in-app adapter's space
// write would go to a different service, which is why that adapter is not used
// here. (Spec: FR-113, FR-116.)
//
// Each public write refuses as well. No public record may cite a members-only
// event, and the share flow EventView can open would post one. Nothing tells
// the index about a record either, since the index must never learn a
// members-only event's URI. (Spec: FR-111a.)
import { atProtoLoginModalState } from '$lib/components/LoginModal.svelte';
import type { EditorAdapter } from '$lib/components/editor/adapter';

const WRITES_NOTHING = 'a members-only event page writes nothing';

export function createMembersOnlyEventAdapter(): EditorAdapter {
	const refuse = async (): Promise<never> => {
		throw new Error(WRITES_NOTHING);
	};
	return {
		features: { delete: false, recurring: false, privateMode: false },
		putRecord: refuse,
		createRecord: refuse,
		deleteRecord: refuse,
		uploadBlob: refuse,
		getRecord: refuse,
		resolveHandle: refuse,
		// The page has no editor, so there is never a save to follow.
		onSaved() {},
		requestLogin() {
			atProtoLoginModalState.show();
		}
	};
}
