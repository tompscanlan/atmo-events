<script lang="ts">
	import { EventView } from '@atmo-dev/events-ui';
	import { page } from '$app/state';
	import { user } from '$lib/atproto/auth.svelte';
	import { createMembersOnlyEventAdapter } from '$lib/groups/event-page-adapter';

	let { data } = $props();

	// The signed-in person views the event, not the group: an RSVP is theirs.
	let viewer = $derived({
		isLoggedIn: user.isLoggedIn,
		did: user.did ?? null,
		handle: user.profile?.handle,
		displayName: user.profile?.displayName,
		avatar: user.profile?.avatar
	});
	// Writes nothing, so the RSVP button is inert until members-only RSVPs land.
	const adapter = createMembersOnlyEventAdapter();
</script>

<EventView {data} {adapter} {viewer} pageUrl={page.url} />
