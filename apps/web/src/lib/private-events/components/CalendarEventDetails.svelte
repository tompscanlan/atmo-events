<script lang="ts">
	import type { RsvpStatus } from '../ids';
	import { UNTITLED_CALENDAR } from '../ids';
	import type { Guest } from '../server/events';
	import CalendarEventGuests from './CalendarEventGuests.svelte';
	import { Icon } from '@atmo-dev/kit';
	import { LockKeyhole } from '@sketchyicons/svelte';
	import { resolve } from '$app/paths';
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
	<span data-testid="private-to"
		><Icon img={LockKeyhole} size={14} class="mr-1 inline align-[-2px]" />Private ·
		<a
			href={resolve('/(app)/p/[actor]/calendar/[key]', { actor, key: calendar.key })}
			class="text-accent-600 dark:text-accent-400 hover:underline"
			>{calendar.name ?? UNTITLED_CALENDAR}</a
		></span
	>
	{#if !isHost && !answered && !answersUnread}<span class="mt-1 block"
			>Answer to let the host know you saw it.</span
		>{/if}
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
