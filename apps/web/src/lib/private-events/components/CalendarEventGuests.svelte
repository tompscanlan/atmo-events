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
		capped = false,
		owner = false,
		you = null
	}: {
		guests: Guest[];
		actor: string;
		calendarKey: string;
		calendarName: string;
		capped?: boolean;
		/** The calendar's owner, who changes the list on the calendar's page. */
		owner?: boolean;
		/** The viewer and their answer as this page knows it, which is newer than the list's once they
		 *  answer here. */
		you?: { did: string; answer: RsvpStatus | null } | null;
	} = $props();

	function answerWords(guest: Guest): string {
		if (you && guest.did === you.did) {
			return you.answer ? ANSWER_WORDS[you.answer] : 'No answer yet';
		}
		if (guest.answer) return ANSWER_WORDS[guest.answer];
		return guest.answerUnread ? "Their answer couldn't be read" : 'No answer yet';
	}
</script>

<section data-testid="calendar-guests">
	<h2 class="text-base-600 dark:text-base-400 mb-3 text-xs font-semibold tracking-wider uppercase">
		{#if guests.length > 0}Invited ({guests.length}){:else}Invited{/if}
	</h2>
	{#if guests.length === 0}
		<p class="text-base-600 dark:text-base-400 text-sm">No one else yet.</p>
	{:else}
		<ul class="space-y-2">
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
	{#if owner}
		<a
			href={resolve('/(app)/p/[actor]/calendar/[key]', { actor, key: calendarKey })}
			class="text-accent-600 dark:text-accent-400 mt-3 block text-sm hover:underline"
			aria-label="Add or remove people on {calendarName}">Add or remove people</a
		>
	{/if}
	{#if capped}
		<p class="text-base-600 dark:text-base-400 mt-2 text-sm" role="status">
			There may be more people on it than these.
		</p>
	{/if}
</section>
