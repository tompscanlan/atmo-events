<script lang="ts">
	import { resolve } from '$app/paths';
	import type { RsvpStatus } from '../ids';
	import type { Guest } from '../server/events';

	const ANSWER_WORDS: Record<RsvpStatus, string> = {
		going: 'Going',
		interested: 'Interested',
		notgoing: 'Not going'
	};

	let {
		guests,
		actor,
		calendarKey,
		calendarName,
		capped = false
	}: {
		guests: Guest[];
		actor: string;
		calendarKey: string;
		calendarName: string;
		capped?: boolean;
	} = $props();

	function answerWords(guest: Guest): string {
		if (guest.answer) return ANSWER_WORDS[guest.answer];
		return guest.answerUnread ? "Their answer couldn't be read" : "Hasn't answered";
	}
</script>

<section data-testid="calendar-guests">
	<h2 class="text-base-600 dark:text-base-400 mb-3 text-xs font-semibold tracking-wider uppercase">
		Guests
	</h2>
	<p class="text-base-600 dark:text-base-400 text-sm">
		Everyone on
		<a
			href={resolve('/(app)/p/[actor]/calendar/[key]', { actor, key: calendarKey })}
			class="text-accent-600 dark:text-accent-400 hover:underline">{calendarName}</a
		> is invited. To add or remove people, go to the calendar.
	</p>
	{#if guests.length === 0}
		<p class="text-base-600 dark:text-base-400 mt-3 text-sm">No one else is on it yet.</p>
	{:else}
		<ul class="mt-3 space-y-2">
			{#each guests as guest (guest.did)}
				<li class="text-sm" data-guest={guest.did}>
					<span class="text-base-900 dark:text-base-50 block truncate font-medium"
						>{guest.handle ?? guest.did}</span
					>
					<span class="text-base-600 dark:text-base-400 block text-xs">{answerWords(guest)}</span>
				</li>
			{/each}
		</ul>
	{/if}
	{#if capped}
		<p class="text-base-600 dark:text-base-400 mt-2 text-sm" role="status">
			There may be more people on it than these.
		</p>
	{/if}
</section>
