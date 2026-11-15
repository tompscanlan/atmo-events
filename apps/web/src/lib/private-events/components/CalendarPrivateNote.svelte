<script lang="ts">
	import { Icon } from '@atmo-dev/kit';
	import { LockKeyhole } from '@sketchyicons/svelte';
	import { resolve } from '$app/paths';
	import { UNTITLED_CALENDAR } from '../ids';

	// One way of saying who can see an event on a shared calendar, wherever one shows.
	let {
		name,
		link = null,
		size = 12
	}: {
		/** The calendar's name; null for a missing or invalid one. */
		name: string | null;
		/** Whose calendar and its key, when the place this shows can link to its page. */
		link?: { actor: string; key: string } | null;
		size?: number;
	} = $props();
</script>

<span data-testid="private-to"
	><Icon img={LockKeyhole} {size} class="mr-1 inline align-[-2px]" />Private event. Only the people
	on
	{#if link}<a
			href={resolve('/(app)/p/[actor]/calendar/[key]', link)}
			class="text-accent-600 dark:text-accent-400 hover:underline">{name ?? UNTITLED_CALENDAR}</a
		>{:else}{name ?? UNTITLED_CALENDAR}{/if}
	can see it.</span
>
