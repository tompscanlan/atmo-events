<script lang="ts">
	import { EventCard } from '@atmo-dev/kit/events';
	import type { FlatEventRecord } from '#lib/contrail.js';

	// One of a host's lists of events, under its heading, with "See all" when there are more: a
	// person's upcoming or past events on their profile, and a group's on its page.
	let {
		heading,
		events,
		actor,
		seeAllHref = null
	}: {
		heading: string;
		events: FlatEventRecord[];
		/** The host, as the page's address names it, for each card's link. */
		actor: string | undefined;
		/** Where "See all" goes, built with resolve(); null when the list is all there is. The lint
		 *  rule that would catch a raw path cannot see through a prop, so it is suppressed at the
		 *  href below, and this contract is what that rests on. */
		seeAllHref?: string | null;
	} = $props();
</script>

<section class="mb-10">
	<div class="mb-4 flex items-baseline justify-between">
		<h2 class="text-base-900 dark:text-base-50 text-lg font-semibold">{heading}</h2>
		{#if seeAllHref}
			<!-- eslint-disable svelte/no-navigation-without-resolve -->
			<a
				href={seeAllHref}
				class="text-accent-600 hover:text-accent-700 dark:text-accent-400 dark:hover:text-accent-300 text-sm font-medium transition-colors"
			>
				See all &rarr;
			</a>
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
		{/if}
	</div>
	<div class="space-y-5">
		{#each events as event (event.uri)}
			<EventCard {event} {actor} />
		{/each}
	</div>
</section>
