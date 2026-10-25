<script lang="ts">
	import { Badge, Button } from '@foxui/core';
	import GroupMonogram from '$lib/groups/components/GroupMonogram.svelte';
	import { resolve } from '$app/paths';

	let { data } = $props();
</script>

<svelte:head>
	<title>Groups - atmo.rsvp</title>
	<meta name="description" content="Groups organizing events on the open social web." />
</svelte:head>

<div class="mx-auto max-w-3xl px-6 py-8 sm:py-12">
	<div class="mb-8 flex items-center justify-between gap-4">
		<div>
			<h1 class="text-3xl font-bold sm:text-4xl">Groups</h1>
			<p class="text-base-500 dark:text-base-400 mt-1">
				Each group is its own account on the network. Its public events live in that account's repo.
			</p>
		</div>
		{#if data.callerDid}
			<Button href="/groups/create" class="shrink-0">New group</Button>
		{/if}
	</div>

	{#if data.groups.length === 0}
		<div class="py-16 text-center">
			<p class="text-base-500 dark:text-base-400 text-lg">No groups yet.</p>
			{#if data.callerDid}
				<p class="mt-2">
					<a href={resolve('/groups/create')} class="text-accent-600 dark:text-accent-400 underline"
						>Create the first one</a
					>
				</p>
			{/if}
		</div>
	{:else}
		<ul class="flex flex-col gap-3">
			{#each data.groups as group (group.group_did)}
				<li
					class="ring-base-200 dark:ring-base-800 hover:ring-base-300 dark:hover:ring-base-700 rounded-2xl p-4 ring-1 transition-colors"
				>
					<div class="flex items-start gap-4">
						<GroupMonogram name={group.name ?? group.handle ?? '?'} />
						<div class="min-w-0 flex-1">
							{#if group.hosted}
								<!-- The DID, never the handle, which can lapse and be re-registered. -->
								<a
									href={resolve('/(app)/groups/[actor]', { actor: group.group_did })}
									class="text-lg font-semibold hover:underline">{group.name}</a
								>
								{#if group.description}
									<p class="text-base-500 dark:text-base-400 mt-1 line-clamp-2 text-sm">
										{group.description}
									</p>
								{/if}
								<p class="text-base-400 dark:text-base-500 mt-2 truncate font-mono text-xs">
									{group.handle ?? group.group_did}
								</p>
							{:else}
								<!-- Declared, with no row here: its name is in a space we cannot read. -->
								<p class="truncate font-mono text-lg font-semibold">
									{group.handle ?? group.group_did}
								</p>
								<p class="text-base-500 dark:text-base-400 mt-1 text-sm">
									Declared on the network. This site has no page for it.
								</p>
							{/if}
						</div>
						<div class="flex shrink-0 gap-2">
							<!-- One of the caller's own groups whose repo does not declare it. -->
							{#if !group.listed}
								<Badge variant="secondary">not listed</Badge>
							{/if}
						</div>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</div>
