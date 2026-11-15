<script lang="ts">
	import type { RsvpStatus } from '../ids';
	import { UNTITLED_CALENDAR } from '../ids';
	import type { Guest } from '../server/events';
	import CalendarEventGuests from './CalendarEventGuests.svelte';
	import CalendarPrivateNote from './CalendarPrivateNote.svelte';
	import FindAgainOffer from './FindAgainOffer.svelte';

	// What an event on a shared calendar shows beside its answers, at either of its addresses.
	let {
		calendar,
		actor,
		isHost,
		answered,
		answersUnread,
		guests,
		guestsCapped,
		viewerDid
	}: {
		calendar: { key: string; name: string | null };
		/** The calendar's owner, by handle when there is one. */
		actor: string;
		isHost: boolean;
		answered: RsvpStatus | null;
		answersUnread: boolean;
		guests: Guest[] | null;
		guestsCapped: boolean;
		viewerDid: string | null;
	} = $props();
</script>

<p class="text-base-600 dark:text-base-400 text-sm" data-testid="private-note">
	<CalendarPrivateNote name={calendar.name} link={{ actor, key: calendar.key }} size={14} />
	{#if !isHost && !answered && !answersUnread}Answer to let the host know you saw it.{/if}
</p>
{#if !isHost && answered}<FindAgainOffer onCalendar />{/if}
{#if guests}
	<CalendarEventGuests
		{guests}
		capped={guestsCapped}
		owner={isHost}
		you={viewerDid ? { did: viewerDid, answer: answered } : null}
		{actor}
		calendarKey={calendar.key}
		calendarName={calendar.name ?? UNTITLED_CALENDAR}
	/>
{/if}
