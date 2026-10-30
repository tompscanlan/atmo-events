<script lang="ts">
	import { Button } from '@atmo-dev/kit';
	import { EventView } from '@atmo-dev/events-ui';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { user } from '#lib/atproto/auth.svelte.js';
	import { createMembersOnlyRsvpAdapter } from '#lib/groups/rsvp-adapter.js';

	let { data } = $props();

	let viewer = $derived({
		isLoggedIn: user.isLoggedIn,
		canPostToBluesky: false,
		did: user.did ?? null,
		handle: user.profile?.handle,
		displayName: user.profile?.displayName,
		avatar: user.profile?.avatar
	});
	let adapter = $derived(createMembersOnlyRsvpAdapter(data.group.did, data.rkey, viewer));
</script>

<EventView {data} {adapter} {viewer} pageUrl={new URL(page.url.href)}>
	{#snippet extraActions()}
		<p class="text-muted text-sm">
			Only members of
			<a class="font-medium" href={resolve('/(app)/groups/[actor]', { actor: data.group.did })}
				>{data.group.name}</a
			> can see this event.
		</p>
		{#if data.group.linked}
			<Button
				variant="secondary"
				class="w-full"
				href={resolve('/(app)/groups/[actor]/events/[rkey]/edit', {
					actor: data.group.did,
					rkey: data.rkey
				})}>Edit event</Button
			>
		{/if}
	{/snippet}
</EventView>
