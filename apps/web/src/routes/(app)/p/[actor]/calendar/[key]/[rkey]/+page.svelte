<script lang="ts">
	import { Button, Icon } from '@atmo-dev/kit';
	import { EventView } from '@atmo-dev/kit/events';
	import { LockKeyhole } from '@sketchyicons/svelte';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { user } from '#lib/atproto/auth.svelte.js';
	import { atProtoLoginModalState } from '#lib/components/LoginModal.svelte';
	import { BETA_WARNING } from '#lib/private-events/beta.js';
	import CalendarEventGuests from '#lib/private-events/components/CalendarEventGuests.svelte';
	import PrivateEventAccessNotice from '#lib/private-events/components/PrivateEventAccessNotice.svelte';
	import { calendarEvent, UNTITLED_CALENDAR } from '#lib/private-events/ids.js';
	import { createPrivateRsvpAdapter } from '#lib/private-events/rsvp-adapter.js';
	import { GUEST_SCOPES, HOST_SCOPES } from '#lib/private-events/scopes.js';

	let { data } = $props();

	let viewer = $derived({
		isLoggedIn: user.isLoggedIn,
		canPostToBluesky: false,
		did: user.did ?? null,
		handle: user.profile?.handle,
		displayName: user.profile?.displayName,
		avatar: user.profile?.avatar
	});
</script>

<svelte:head><meta name="robots" content="noindex" /></svelte:head>

{#if data.view === 'event'}
	{@const adapter = createPrivateRsvpAdapter(
		calendarEvent(data.actorDid, data.calendar.key, data.rkey),
		viewer
	)}
	{@const calendarName = data.calendar.name ?? UNTITLED_CALENDAR}
	{@const actor = data.hostProfile.handle ?? data.actorDid}
	<!-- A private event has no public page to share, so the page offers no Bluesky post. -->
	<EventView {data} {adapter} {viewer} pageUrl={new URL(page.url.href)} share={false}>
		{#snippet extraActions()}
			<p class="text-base-600 dark:text-base-400 text-sm" data-testid="beta-notice">
				{BETA_WARNING}
			</p>
			{#if data.answersUnread}
				<p
					class="text-base-600 dark:text-base-400 text-sm"
					role="status"
					data-testid="answers-unread"
				>
					Some answers couldn't be read just now, so this may not show everyone's. Try again
					shortly.
				</p>
			{/if}
			<p class="text-base-600 dark:text-base-400 text-sm" data-testid="private-note">
				<Icon img={LockKeyhole} size={14} class="inline align-[-2px]" />
				Private event. Only the people on
				<a
					href={resolve('/(app)/p/[actor]/calendar/[key]', { actor, key: data.calendar.key })}
					class="text-accent-600 dark:text-accent-400 hover:underline">{calendarName}</a
				>
				can see it.
				{#if !data.guests && !data.viewerRsvpStatus && !data.answersUnread}Answer to let the host
					know you saw it.{/if}
			</p>
			{#if data.guests}
				<CalendarEventGuests
					guests={data.guests}
					{actor}
					calendarKey={data.calendar.key}
					{calendarName}
				/>
			{/if}
		{/snippet}
	</EventView>
{:else}
	<div class="mx-auto max-w-3xl px-6 py-8 sm:py-12">
		<h1 class="text-base-900 dark:text-base-50 text-2xl font-bold">Private event</h1>
		<p class="text-base-600 dark:text-base-400 mt-2 text-sm" data-testid="beta-notice">
			{BETA_WARNING}
		</p>
		{#if data.view === 'signed-out'}
			<p class="text-base-600 dark:text-base-400 mt-2">Sign in to see whether you were invited.</p>
			<Button class="mt-4" onclick={() => atProtoLoginModalState.show()}>Sign in</Button>
		{:else}
			<PrivateEventAccessNotice
				access={data.access}
				did={data.did}
				scopes={data.isHost ? HOST_SCOPES : GUEST_SCOPES}
				purpose={data.isHost
					? 'Your sign-in no longer lets atmo open your private events. Allow it again to see this one and who is coming.'
					: 'Private events are kept on the host’s server. atmo needs your permission to open them for you and save your answer in your own account.'}
				label={data.isHost ? 'Allow atmo again' : 'Allow atmo to open private events'}
				spacesServer={data.spacesServer}
			/>
		{/if}
	</div>
{/if}
