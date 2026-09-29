<script lang="ts">
	import { Button } from '@foxui/core';
	import { EventCard, type FlatEventRecord } from '@atmo-dev/events-ui';
	import type { GroupEventRecord } from '$lib/groups/types';
	import PdslsLink from '$lib/groups/components/PdslsLink.svelte';
	import { resolve } from '$app/paths';

	let { data } = $props();

	let group = $derived(data.group);
	// The loader reads the group's name from the about space, not from a column,
	// so this tab shows the same name as the group page.
	let groupName = $derived(data.groupName);

	/** The group's records as the cards the rest of the app uses. `did` is the
	 *  group's, so the card links to the group's event page, not an admin's. */
	function toCard(event: GroupEventRecord): FlatEventRecord {
		return {
			...(event.value as unknown as FlatEventRecord),
			did: group.group_did,
			rkey: event.rkey,
			uri: event.uri,
			cid: event.cid || null
		};
	}
</script>

<svelte:head><title>{groupName} events - atmo.rsvp</title></svelte:head>

<div class="mx-auto max-w-3xl px-6 py-8 sm:py-12">
	<a
		href={resolve('/(app)/groups/[actor]', { actor: group.group_did })}
		class="text-base-500 dark:text-base-400 mb-4 inline-block text-sm hover:underline"
		>← {groupName}</a
	>

	<div class="mb-2 flex flex-wrap items-center justify-between gap-4">
		<h1 class="text-3xl font-bold">Events</h1>
		{#if data.canCreateEvent}
			<!-- atmo's own event editor, publishing as the group. -->
			<Button href={resolve('/(app)/groups/[actor]/events/new', { actor: group.group_did })}
				>New group event</Button
			>
		{/if}
	</div>
	<p class="text-base-500 dark:text-base-400 mb-8 text-sm">
		Published as
		<PdslsLink
			to={group.group_did}
			title="The group's account on pds.ls"
			class="font-mono hover:underline"
			>{data.handle ? `@${data.handle}` : group.group_did}</PdslsLink
		>. The group is the author, not whoever pressed the button.
	</p>

	{#if data.events.length === 0}
		<div class="py-16 text-center">
			<p class="text-base-500 dark:text-base-400 text-lg">This group has no public events yet.</p>
		</div>
	{:else}
		<div class="flex flex-col gap-6">
			{#each data.events as event (event.rkey)}
				<div>
					<EventCard event={toCard(event)} actor={group.group_did} />
					<div class="mt-2 flex items-center gap-3">
						<!-- Any MANAGE_EVENTS holder edits any event here: they are all the
						     group's records, not each admin's. -->
						{#if data.canManageEvents}
							<a
								href={resolve('/(app)/groups/[actor]/events/[rkey]/edit', {
									actor: group.group_did,
									rkey: event.rkey
								})}
								class="text-base-500 dark:text-base-400 text-sm hover:underline">Edit</a
							>
						{/if}
						<PdslsLink
							to={event.uri}
							title="This event's record on pds.ls"
							class="text-base-400 dark:text-base-500 text-xs hover:underline">record ↗</PdslsLink
						>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>
