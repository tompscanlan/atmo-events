<script lang="ts">
	import { Button, Icon } from '@atmo-dev/kit';
	import { EventView } from '@atmo-dev/kit/events';
	import { LockKeyhole } from '@sketchyicons/svelte';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { user } from '#lib/atproto/auth.svelte.js';
	import { atProtoLoginModalState } from '#lib/components/LoginModal.svelte';
	import GroupAccessNotice from '#lib/groups/components/GroupAccessNotice.svelte';
	import { createMembersOnlyRsvpAdapter } from '#lib/groups/rsvp-adapter.js';
	import { holdPrivateEmbeds } from '#lib/private-events/embeds.js';

	// A group's members-only event: built as a private event's page is, with the group's words.
	let { data } = $props();
	holdPrivateEmbeds();

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
	{@const adapter = createMembersOnlyRsvpAdapter(data.group.did, data.rkey, viewer)}
	<!-- It has no public page to share, so the page offers no Bluesky post. -->
	<EventView {data} {adapter} {viewer} pageUrl={new URL(page.url.href)} share={false}>
		{#snippet extraActions()}
			<!-- Private only while its calendar is still for members alone, as read now. -->
			<p class="text-base-600 dark:text-base-400 text-sm" data-testid="private-note">
				{#if data.calendarPrivacy === 'private'}
					<Icon img={LockKeyhole} size={12} class="mr-1 inline align-[-2px]" />Private event. Only
					members of {data.group.name} can see it.
				{:else if data.calendarPrivacy === 'public'}
					This event's calendar can now be read by more than the members of {data.group.name}, so it
					is no longer private.
				{:else}
					Whether this event is still for the members of {data.group.name} alone couldn't be checked just
					now.
				{/if}
			</p>
			{#if !data.canRsvp}
				<p class="text-base-600 dark:text-base-400 text-sm" role="status">
					To RSVP, allow atmo to act for you in groups on
					<a
						class="text-accent-600 dark:text-accent-400 hover:underline"
						href={resolve('/(app)/groups/[actor]', { actor: data.group.did })}>the group's page</a
					>.
				</p>
			{/if}
			{#if data.canEdit}
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
{:else}
	<div class="mx-auto max-w-3xl px-6 py-8 sm:py-12">
		<h1 class="text-base-900 dark:text-base-50 text-2xl font-bold">Members-only event</h1>
		{#if data.view === 'signed-out'}
			<p class="text-base-600 dark:text-base-400 mt-2">
				Sign in to see whether you are a member of {data.group.name}.
			</p>
			<Button class="mt-4" onclick={() => atProtoLoginModalState.show()}>Sign in</Button>
		{:else}
			<GroupAccessNotice
				access={data.access}
				did={data.did}
				purpose="A group's members-only events are kept at its group host. atmo needs your permission to open them for you and save your RSVP in your own account."
				spacesServer={data.spacesServer}
			/>
		{/if}
	</div>
{/if}
