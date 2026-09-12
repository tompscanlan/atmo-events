<script lang="ts">
	import { Badge, Button } from '@foxui/core';

	let { data } = $props();
</script>

<svelte:head>
	<title>Groups — atmo.rsvp</title>
	<meta name="description" content="Groups organising events on the open social web." />
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
					<a href="/groups/create" class="text-accent-600 dark:text-accent-400 underline"
						>Create the first one</a
					>
				</p>
			{/if}
		</div>
	{:else}
		<ul class="flex flex-col gap-3">
			{#each data.groups as group (group.id)}
				<li
					class="ring-base-200 dark:ring-base-800 hover:ring-base-300 dark:hover:ring-base-700 rounded-2xl p-4 ring-1 transition-colors"
				>
					<div class="flex items-start justify-between gap-4">
						<div class="min-w-0">
							<a href="/groups/{group.slug}" class="text-lg font-semibold hover:underline"
								>{group.name}</a
							>
							{#if group.description}
								<p class="text-base-500 dark:text-base-400 mt-1 line-clamp-2 text-sm">
									{group.description}
								</p>
							{/if}
							<p class="text-base-400 dark:text-base-500 mt-2 truncate font-mono text-xs">
								{group.group_did}
							</p>
						</div>
						<div class="flex shrink-0 gap-2">
							{#if group.status !== 'published'}
								<Badge variant="secondary">{group.status}</Badge>
							{/if}
							{#if group.visibility !== 'public'}
								<Badge variant="secondary">{group.visibility}</Badge>
							{/if}
						</div>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</div>
