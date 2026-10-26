<script lang="ts">
	import { Button } from '@foxui/core';
	import GroupEventList from '$lib/groups/components/GroupEventList.svelte';
	import GroupSignInNotice from '$lib/groups/components/GroupSignInNotice.svelte';
	import { resolve } from '$app/paths';

	let { data } = $props();

	let group = $derived(data.group!);
	let groupName = $derived(data.groupName);
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
		<!-- For whoever writes them; a visitor reads the group's name on each event's own page. -->
		{#if data.canCreateEvent}
			<p class="text-base-500 dark:text-base-400 text-sm">
				Published as {data.handle ? `@${data.handle}` : group.group_did}. The group is the author,
				not whoever pressed the button.
			</p>
		{/if}

		{#if data.membersOnlyNotice}
			<p
				class="border-base-200 dark:border-base-800 text-base-600 dark:text-base-300 mt-6 rounded-lg border px-4 py-3 text-sm"
				role="status"
			>
				{data.membersOnlyNotice}
			</p>
		{/if}

		{#if data.upcoming.length === 0 && data.past.length === 0}
			<div class="py-16 text-center">
				<p class="text-base-500 dark:text-base-400 text-lg">This group has no events yet.</p>
			</div>
		{:else}
			<section class="mt-8">
				<h2 class="mb-4 text-xl font-semibold">Upcoming</h2>
				{#if data.upcoming.length === 0}
					<p class="text-base-500 dark:text-base-400 text-sm">Nothing planned right now.</p>
				{:else}
					<GroupEventList
						groupDid={group.group_did}
						events={data.upcoming}
						canManageEvents={data.canManageEvents}
					/>
				{/if}
			</section>
			{#if data.past.length > 0}
				<section class="mt-12">
					<h2 class="mb-4 text-xl font-semibold">Past</h2>
					<GroupEventList
						groupDid={group.group_did}
						events={data.past}
						canManageEvents={data.canManageEvents}
					/>
				</section>
			{/if}
		{/if}
	</div>
{/if}
