// The adapter a members-only event's page hands the shared EventView.
//
// Its one write is the member's RSVP to this event. EventView's RSVP button
// writes into the event's space only through the adapter's space methods, and
// these call the two members-only RSVP commands and nothing else. The server
// picks the space, the collection, the key and the subject, so a command names
// only the event and the answer. A space write that is not an RSVP to this
// event in its calendar space is refused before any command, and nothing ever
// falls back to a public RSVP, which would publish the event's URI and who is
// going. The in-app adapter's space write goes to a different service, which is
// why that adapter is not used here. (Spec: FR-113, FR-116.)
//
// A session without the grant comes back with a re-authorize URL. The page URL
// is marked first, so that when the member returns, the next RSVP tells the
// server a re-authorization asked for the grant: only then may it say the
// member's PDS can't do this. Every other failure is shown through `onNotice`.
// A failed cancel throws, so the RSVP button keeps showing the RSVP that is
// still there. (Spec: FR-114.)
//
// Each public write refuses as well. No public record may cite a members-only
// event, and the share flow EventView can open would post one. Nothing tells
// the index about a record either, since the index must never learn a
// members-only event's URI. (Spec: FR-111a.)
import { atProtoLoginModalState } from '$lib/components/LoginModal.svelte';
import type { EditorAdapter } from '$lib/components/editor/adapter';
import { reauthorize } from '$lib/atproto/auth.svelte';
import type { MembersOnlyRsvpCancel, MembersOnlyRsvpPut } from './server/member-rsvp';

const WRITES_NOTHING = 'a members-only event page writes nothing';
const NOT_THIS_RSVP = 'a members-only event page writes only an RSVP to its own event';
const RSVP_COLLECTION = 'community.lexicon.calendar.rsvp';
const EVENT_COLLECTION = 'community.lexicon.calendar.event';
const STATUSES = ['going', 'interested', 'notgoing'] as const;
type RsvpStatus = (typeof STATUSES)[number];

/** The query parameter that marks a page reached back from a re-authorization
 *  that asked for the RSVP grant. */
const GRANT_PARAM = 'rsvp-grant';
const GRANT_ASKED = 'asked';

/** Shown when a command could not be reached at all. */
const UNSENT = "Your RSVP couldn't be sent. Check your connection and try again.";
/** Shown to a caller the server no longer finds on the roster. */
const NOT_A_MEMBER = "Only the group's members can RSVP to this event, so nothing was saved.";

/** Whether `url` is the page reached back from a re-authorization that asked
 *  for the RSVP grant. */
export function rsvpGrantAsked(url: URL): boolean {
	return url.searchParams.get(GRANT_PARAM) === GRANT_ASKED;
}

export interface MembersOnlyEventPage {
	/** The group's DID, as the page has it. */
	groupDid: string;
	/** The event's key. */
	rkey: string;
	/** The group's calendar space, where the event is. Null refuses every space
	 *  write. */
	calendarSpaceUri: string | null;
	/** Whether this page was reached back from a re-authorization that asked
	 *  for the RSVP grant (`rsvpGrantAsked`). */
	asked: boolean;
	/** Shows a message about the last RSVP, or clears it with null. */
	onNotice(message: string | null): void;
}

/** What either command answers. */
type CommandResult = MembersOnlyRsvpPut | MembersOnlyRsvpCancel;

export function createMembersOnlyEventAdapter(page: MembersOnlyEventPage): EditorAdapter {
	const { groupDid, rkey, calendarSpaceUri, asked, onNotice } = page;
	/** The event's space-form URI, which an RSVP to it names. (Spec: FR-120.) */
	const eventUri =
		calendarSpaceUri && `${calendarSpaceUri}/${groupDid}/${EVENT_COLLECTION}/${rkey}`;
	/** Whether a space write is to this event's calendar space, in the RSVP collection. */
	const isRsvpHere = (spaceUri: string, collection: string) =>
		!!calendarSpaceUri && spaceUri === calendarSpaceUri && collection === RSVP_COLLECTION;

	const refuse = async (): Promise<never> => {
		throw new Error(WRITES_NOTHING);
	};

	/** The answer an RSVP record gives this event, or null for any record that is
	 *  not an RSVP to it. */
	function statusOf(record: Record<string, unknown>): RsvpStatus | null {
		const subject = record.subject as { uri?: unknown } | undefined;
		if (!eventUri || subject?.uri !== eventUri) return null;
		return STATUSES.find((s) => record.status === `${RSVP_COLLECTION}#${s}`) ?? null;
	}

	/** Runs a command and acts on its answer. True when it saved. */
	async function settle(run: () => Promise<CommandResult>): Promise<boolean> {
		let result: CommandResult;
		try {
			result = await run();
		} catch (e) {
			console.error('[groups] the RSVP command could not be reached:', e);
			onNotice(UNSENT);
			return false;
		}
		if (result.ok) {
			onNotice(null);
			return true;
		}
		if (result.reason === 'reauthorize') {
			// Marked first, so the page the member comes back to says it asked.
			const url = new URL(window.location.href);
			url.searchParams.set(GRANT_PARAM, GRANT_ASKED);
			history.replaceState(history.state, '', url);
			reauthorize(result.url);
			return false;
		}
		onNotice(result.reason === 'not-member' ? NOT_A_MEMBER : result.message);
		return false;
	}

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
		},
		async putSpaceRecord({ spaceUri, collection, record }) {
			const status = isRsvpHere(spaceUri, collection) ? statusOf(record) : null;
			if (!status) return { ok: false };
			const saved = await settle(async () => {
				const { rsvpToMembersOnlyEvent } = await import('./groups.remote');
				return rsvpToMembersOnlyEvent({ groupDid, rkey, status, asked });
			});
			return { ok: saved };
		},
		async deleteSpaceRecord({ spaceUri, collection }) {
			if (!isRsvpHere(spaceUri, collection)) throw new Error(NOT_THIS_RSVP);
			const cancelled = await settle(async () => {
				const { cancelMembersOnlyRsvp } = await import('./groups.remote');
				return cancelMembersOnlyRsvp({ groupDid, rkey, asked });
			});
			if (!cancelled) throw new Error('the RSVP was not cancelled');
		}
	};
}
