<script lang="ts">
	import { Avatar, Badge, Button, Input, Label } from '@atmo-dev/kit';
	import { resolve } from '$app/paths';

	let { data } = $props();

	// Paths are resolved; the query strings are appended to them.
	const listUrl = (query: Record<string, string>) =>
		`${resolve('/(app)/groups')}?${new URLSearchParams(query)}`;
</script>

<div class="mx-auto max-w-3xl px-6 py-8 sm:py-12">
	{#if data.server}
		<div class="mb-6">
			<a
				href={resolve('/(app)/groups')}
				class="text-accent-600 hover:text-accent-700 dark:text-accent-400 dark:hover:text-accent-300 text-sm font-medium transition-colors"
			>
				&larr; All groups
			</a>
		</div>
		<h1 class="text-base-900 dark:text-base-50 text-2xl font-bold">
			Groups at {data.server.host}
		</h1>
	{:else}
		<h1 class="text-base-900 dark:text-base-50 text-2xl font-bold">Groups</h1>
	{/if}

	{#if data.notice}
		<p role="status" class="text-base-600 dark:text-base-400 mt-4 text-sm">{data.notice}</p>
	{/if}

	{#if data.canLink}
		<form method="POST" action="/oauth/group/link" class="mt-6 flex flex-wrap items-end gap-2">
			<div class="min-w-0 flex-1">
				<Label for="group-link">Link a group you help run, to post its events</Label>
				<Input id="group-link" name="group" placeholder="group.example.com" required />
			</div>
			<Button type="submit" variant="secondary">Link</Button>
		</form>
	{/if}

	{#if data.declaredUnavailable}
		<p class="text-base-600 dark:text-base-400 mt-6 text-sm">
			The groups list could not be loaded. Try again shortly.
		</p>
	{/if}

	{#if data.groups.length > 0}
		<ul class="divide-base-200 dark:divide-base-800 mt-6 divide-y">
			{#each data.groups as group (group.did)}
				<li>
					<a
						href={resolve('/(app)/groups/[actor]', { actor: group.did })}
						class="hover:bg-base-100 dark:hover:bg-base-900/50 -mx-2 flex items-start gap-3 rounded-lg px-2 py-3 transition-colors"
					>
						<Avatar name={group.name} size={40} />
						<span class="min-w-0 flex-1">
							<span class="text-base-900 dark:text-base-50 flex items-center gap-2 font-medium">
								<span class="truncate">{group.name}</span>
								{#if group.linked}<Badge>Linked</Badge>{/if}
							</span>
							{#if group.handle}
								<span class="text-base-600 dark:text-base-400 block truncate text-sm"
									>@{group.handle}</span
								>
							{/if}
							{#if group.description}
								<span class="text-base-600 dark:text-base-400 mt-1 line-clamp-2 block text-sm"
									>{group.description}</span
								>
							{/if}
						</span>
					</a>
				</li>
			{/each}
		</ul>
		<!-- eslint-disable svelte/no-navigation-without-resolve -->
		{#if data.cursor}
			<a
				href={listUrl({
					...(data.server ? { server: data.server.origin } : {}),
					cursor: data.cursor
				})}
				class="text-accent-600 hover:text-accent-700 dark:text-accent-400 dark:hover:text-accent-300 mt-6 inline-block text-sm font-medium transition-colors"
				>More groups &rarr;</a
			>
		{/if}
		{#if data.crowded.length > 0}
			<section class="mt-8" aria-labelledby="more-by-server">
				<h2 id="more-by-server" class="text-base-900 dark:text-base-50 text-lg font-semibold">
					More groups by server
				</h2>
				<p class="text-base-600 dark:text-base-400 mt-1 text-sm">
					The list shows up to 20 groups from any one server but this site’s own. These have more.
				</p>
				<ul class="mt-3 space-y-2 text-sm">
					{#each data.crowded as entry (entry.server)}
						<li>
							<a
								href={listUrl({ server: entry.server })}
								class="text-accent-600 hover:text-accent-700 dark:text-accent-400 dark:hover:text-accent-300 font-medium transition-colors"
								>{entry.host}</a
							>
							<span class="text-base-600 dark:text-base-400">{entry.more} more</span>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
		<!-- eslint-enable svelte/no-navigation-without-resolve -->
	{:else if !data.declaredUnavailable}
		<p class="text-base-600 dark:text-base-400 py-12 text-center">No groups yet.</p>
	{/if}
</div>
