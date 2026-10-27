<script lang="ts">
	import { Button } from '@foxui/core';
	import { EventCard, type FlatEventRecord } from '@atmo-dev/events-ui';
	import type { GroupEventRecord } from '$lib/groups/types';
	import GroupSignInNotice from '$lib/groups/components/GroupSignInNotice.svelte';
	import { resolve } from '$app/paths';

	let { data } = $props();

	let group = $derived(data.group!);
	let groupName = $derived(data.groupName);

	// `did` is the group's, so the card links to the group's event page.
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

<svelte:head>
	<title>{data.signInOnly ? 'Group events' : `${groupName} events`} - atmo.rsvp</title>
</svelte:head>

{#if data.signInOnly}
	<div class="mx-auto max-w-3xl px-6 py-8 sm:py-12">
		<GroupSignInNotice groupDid={data.groupDid} subject="group" />
	</div>
{:else}
	<div class="mx-auto max-w-3xl px-6 py-8 sm:py-12">
		<a
			href={resolve('/(app)/groups/[actor]', { actor: group.group_did })}
			class="text-base-500 dark:text-base-400 mb-4 inline-block text-sm hover:underline"
			>← {groupName}</a
		>

		<div class="mb-2 flex flex-wrap items-center justify-between gap-4">
			<h1 class="text-3xl font-bold">Events</h1>
			{#if data.canCreateEvent}
				<Button href={resolve('/(app)/groups/[actor]/events/new', { actor: group.group_did })}
					>New group event</Button
				>
			{/if}
		</div>
		<p class="text-base-500 dark:text-base-400 mb-8 text-sm">
			Published as {data.handle ? `@${data.handle}` : group.group_did}. The group is the author, not
			whoever pressed the button.
		</p>

		{#if data.events.length === 0}
			<div class="py-16 text-center">
				<p class="text-base-500 dark:text-base-400 text-lg">This group has no public events yet.</p>
			</div>
		{:else}
			<div class="flex flex-col gap-6">
				{#each data.events as event (event.uri)}
					<div>
						<EventCard event={toCard(event)} actor={group.group_did} />
						{#if data.canManageEvents}
							<a
								href={resolve('/(app)/groups/[actor]/events/[rkey]/edit', {
									actor: group.group_did,
									rkey: event.rkey
								})}
								class="text-base-500 dark:text-base-400 mt-2 inline-block text-sm hover:underline"
								>Edit</a
							>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/if}
