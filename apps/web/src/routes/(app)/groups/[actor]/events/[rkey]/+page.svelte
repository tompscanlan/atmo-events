<script lang="ts">
	import { EventView } from '@atmo-dev/events-ui';
	import { page } from '$app/state';
	import { user } from '$lib/atproto/auth.svelte';
	import { createMembersOnlyEventAdapter, rsvpGrantAsked } from '$lib/groups/event-page-adapter';

	let { data } = $props();

	// The signed-in person views the event, not the group: an RSVP is theirs.
	let viewer = $derived({
		isLoggedIn: user.isLoggedIn,
		did: user.did ?? null,
		handle: user.profile?.handle,
		displayName: user.profile?.displayName,
		avatar: user.profile?.avatar
	});
	// What the last RSVP came to, when it did not save.
	let notice: string | null = $state(null);
	// Its one write is the member's RSVP to this event, through the members-only
	// RSVP commands.
	let adapter = $derived(
		createMembersOnlyEventAdapter({
			groupDid: data.actorDid,
			rkey: data.rkey,
			calendarSpaceUri: data.spaceUri ?? null,
			asked: rsvpGrantAsked(page.url),
			onNotice: (message) => (notice = message)
		})
	);
</script>

{#if notice}
	<p
		role="status"
		class="border-base-200 dark:border-base-800 bg-base-100 dark:bg-base-950/50 text-base-700 dark:text-base-300 mx-auto mt-6 max-w-3xl rounded-2xl border px-4 py-3 text-sm"
	>
		{notice}
	</p>
{/if}
<EventView {data} {adapter} {viewer} pageUrl={page.url} />
