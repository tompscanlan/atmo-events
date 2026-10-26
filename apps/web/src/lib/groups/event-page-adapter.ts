// What a members-only event's page hands the shared EventView. Its one write is the member's
// RSVP to this event, through the members-only RSVP commands; every other write is refused,
// since no public record may cite a members-only event and the index must never learn its URI.
//
// A session without the grant comes back with a sign-in URL. The page marks its address with
// `reauthorized` first, so the RSVP made after the member returns says they went through it;
// a save takes the mark out again.
import { replaceState } from '$app/navigation';
import { resolve } from '$app/paths';
import { page as appPage } from '$app/state';
import { atProtoLoginModalState } from '$lib/components/LoginModal.svelte';
import type { EditorAdapter } from '$lib/components/editor/adapter';
import { reauthorize } from '$lib/atproto/auth.svelte';
import type { MembersOnlyRsvpCancel, MembersOnlyRsvpPut } from './server/member-rsvp';
import {
	GROUP_EVENT_COLLECTION,
	GROUP_RSVP_COLLECTION,
	RSVP_STATUSES,
	spaceRecordUri,
	type RsvpStatus
} from './ids';

const WRITES_NOTHING = 'a members-only event page writes nothing';
const NOT_THIS_RSVP = 'a members-only event page writes only an RSVP to its own event';
const REAUTHORIZED = 'reauthorized';
const UNSENT = "Your RSVP couldn't be sent. Check your connection and try again.";
const NOT_A_MEMBER = "Only the group's members can RSVP to this event, so nothing was saved.";

export function cameBackFromSignIn(url: URL): boolean {
	return url.searchParams.has(REAUTHORIZED);
}

export interface MembersOnlyEventPage {
	groupDid: string;
	rkey: string;
	/** Null refuses every space write. */
	calendarSpaceUri: string | null;
	reauthorized: boolean;
	/** Shows a message about the last RSVP, or clears it with null. */
	onNotice(message: string | null): void;
}

export function createMembersOnlyEventAdapter(page: MembersOnlyEventPage): EditorAdapter {
	const { groupDid, rkey, calendarSpaceUri, onNotice } = page;
	let reauthorized = page.reauthorized;
	const eventUri =
		calendarSpaceUri && spaceRecordUri(calendarSpaceUri, groupDid, GROUP_EVENT_COLLECTION, rkey);
	const isRsvpHere = (spaceUri: string, collection: string) =>
		!!calendarSpaceUri && spaceUri === calendarSpaceUri && collection === GROUP_RSVP_COLLECTION;
	const refuse = async (): Promise<never> => {
		throw new Error(WRITES_NOTHING);
	};

	function statusOf(record: Record<string, unknown>): RsvpStatus | null {
		const subject = record.subject as { uri?: unknown } | undefined;
		if (!eventUri || subject?.uri !== eventUri) return null;
		return RSVP_STATUSES.find((s) => record.status === `${GROUP_RSVP_COLLECTION}#${s}`) ?? null;
	}

	function cidOf(record: Record<string, unknown>): string | null {
		const cid = (record.subject as { cid?: unknown } | undefined)?.cid;
		return typeof cid === 'string' ? cid : null;
	}

	/** Through SvelteKit, so its router keeps the entry; the rest of the query stays. */
	function markAddress(mark: boolean) {
		const actor = appPage.params.actor ?? groupDid;
		const url = new URL(
			resolve('/(app)/groups/[actor]/events/[rkey]', { actor, rkey }),
			appPage.url
		);
		url.search = appPage.url.search;
		if (mark) url.searchParams.set(REAUTHORIZED, '1');
		else url.searchParams.delete(REAUTHORIZED);
		try {
			// The path came from resolve(); a query string cannot go through it.
			// eslint-disable-next-line svelte/no-navigation-without-resolve
			replaceState(url, appPage.state);
		} catch (e) {
			console.error('[groups] the RSVP mark could not be written to the address:', e);
		}
	}

	async function settle(
		run: () => Promise<MembersOnlyRsvpPut | MembersOnlyRsvpCancel>
	): Promise<boolean> {
		let result: MembersOnlyRsvpPut | MembersOnlyRsvpCancel;
		try {
			result = await run();
		} catch (e) {
			console.error('[groups] the RSVP command could not be reached:', e);
			onNotice(UNSENT);
			return false;
		}
		if (result.ok) {
			onNotice(null);
			if (reauthorized) {
				reauthorized = false;
				markAddress(false);
			}
			return true;
		}
		if (result.reason === 'reauthorize') {
			markAddress(true);
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
		onSaved() {},
		requestLogin() {
			atProtoLoginModalState.show();
		},
		async putSpaceRecord({ spaceUri, collection, record }) {
			const status = isRsvpHere(spaceUri, collection) ? statusOf(record) : null;
			if (!status) return { ok: false };
			const saved = await settle(async () => {
				const { rsvpToMembersOnlyEvent } = await import('./member-rsvp.remote');
				return rsvpToMembersOnlyEvent({ groupDid, rkey, status, cid: cidOf(record), reauthorized });
			});
			return { ok: saved };
		},
		async deleteSpaceRecord({ spaceUri, collection }) {
			if (!isRsvpHere(spaceUri, collection)) throw new Error(NOT_THIS_RSVP);
			const cancelled = await settle(async () => {
				const { cancelMembersOnlyRsvp } = await import('./member-rsvp.remote');
				return cancelMembersOnlyRsvp({ groupDid, rkey, reauthorized });
			});
			// A throw keeps the RSVP button showing the RSVP that is still there.
			if (!cancelled) throw new Error('the RSVP was not cancelled');
		}
	};
}
