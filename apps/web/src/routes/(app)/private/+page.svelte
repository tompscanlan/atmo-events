<script lang="ts">
	import { Icon } from '@atmo-dev/kit';
	import { LockKeyhole } from '@sketchyicons/svelte';
	import { resolve } from '$app/paths';
	import { BETA_WARNING } from '#lib/private-events/beta.js';
	import NewCalendarForm from '#lib/private-events/components/NewCalendarForm.svelte';
	import PrivateEventAccessNotice from '#lib/private-events/components/PrivateEventAccessNotice.svelte';
	import { UNTITLED_CALENDAR } from '#lib/private-events/ids.js';
	import { GUEST_SCOPES, HOST_SCOPES } from '#lib/private-events/scopes.js';

	// Only shared calendars are listed here. Their events are on each calendar's own page. With
	// private events on, every private event, on a calendar or not, is in Your events on the home page.
	let { data } = $props();

	// Whole phrases with their own spaces, so the line reads right whichever parts show.
	const SHOWS_ONCE_ANSWERED = "A calendar you're on shows here once you answer one of its events. ";
	let afterYourEvents = $derived(data.beta ? '.' : ' once private events are on.');
</script>

<svelte:head><meta name="robots" content="noindex" /></svelte:head>

<div class="mx-auto max-w-3xl px-6 py-8 sm:py-12">
	<h1 class="text-base-900 dark:text-base-50 text-2xl font-bold">Calendars</h1>
	<p class="text-base-600 dark:text-base-400 mt-2 text-sm" data-testid="beta-notice">
		{BETA_WARNING}
		{#if !data.beta}To make your own, turn on private events in
			<a
				href={resolve('/(app)/settings')}
				class="text-accent-600 dark:text-accent-400 hover:underline">Settings</a
			>.{/if}
	</p>
	{#if !data.canList}
		<PrivateEventAccessNotice
			access={data.access ?? 'ask'}
			did={data.did}
			scopes={GUEST_SCOPES}
			purpose="Shared calendars and private events are kept on each host’s server. atmo needs your permission to open them for you and save your answers in your own account."
			label="Allow atmo to open private events"
			spacesServer={data.spacesServer}
		/>
	{/if}
	{#if data.incomplete}
		<p
			class="text-base-600 dark:text-base-400 mt-4 text-sm"
			role="status"
			data-testid="private-events-incomplete"
		>
			Some of your calendars couldn't be read just now, so there may be more than these. Try again
			shortly.
		</p>
	{/if}
	{#if data.beta || data.calendars.length > 0}
		<section class="mt-6" aria-label="Shared calendars" data-testid="shared-calendars">
			{#if data.calendars.length > 0}
				<ul class="space-y-3" data-testid="calendar-list">
					{#each data.calendars as calendar (calendar.href)}
						{@const actor = calendar.ownerHandle ?? calendar.host}
						<li class="flex items-baseline gap-2 text-sm" data-calendar={calendar.key}>
							<Icon img={LockKeyhole} size={14} class="text-base-500 shrink-0 self-center" />
							<span class="sr-only">Private:</span>
							<a
								href={resolve('/(app)/p/[actor]/calendar/[key]', { actor, key: calendar.key })}
								class="text-base-900 dark:text-base-50 font-medium hover:underline"
								>{calendar.name ?? UNTITLED_CALENDAR}</a
							>
							<span class="text-base-600 dark:text-base-400 text-xs"
								>{calendar.owning ? 'yours' : actor}</span
							>
						</li>
					{/each}
				</ul>
			{/if}
			{#if data.calendarAccess === 'ready'}
				<div class="mt-8"><NewCalendarForm /></div>
			{:else if data.calendarAccess}
				<div class="mt-8">
					<PrivateEventAccessNotice
						access={data.calendarAccess}
						did={data.did}
						scopes={HOST_SCOPES}
						purpose="A shared calendar is kept on your own server. atmo needs your permission to make it there, keep its name and its list of people, and put your events on it."
						label="Allow atmo to make shared calendars"
						spacesServer={data.spacesServer}
					/>
				</div>
			{/if}
		</section>
	{/if}
	<p class="text-base-600 dark:text-base-400 mt-10 text-xs" data-testid="calendars-footnote">
		{#if data.canList}{SHOWS_ONCE_ANSWERED}{/if}Private events not on a calendar are in
		<a href={resolve('/(app)')} class="text-accent-600 dark:text-accent-400 hover:underline"
			>Your events</a
		>{afterYourEvents}
	</p>
</div>
