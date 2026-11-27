<script lang="ts">
	import { Avatar, Badge, Button, Input, Label } from '@atmo-dev/kit';
	import { resolve } from '$app/paths';

	let { data } = $props();

	// Paths are resolved; the query strings are appended to them.
	const listUrl = (query: Record<string, string>) =>
		`${resolve('/(app)/groups')}?${new URLSearchParams(query)}`;

	/** One server's groups, or a search's, rather than the groups with an event coming. */
	let declared = $derived(data.server !== null || data.q !== null);
	let moreUrl = $derived(
		data.cursor
			? listUrl({
					...(data.server ? { server: data.server.origin } : {}),
					...(data.q ? { q: data.q } : {}),
					cursor: data.cursor
				})
			: null
	);

	// As an event card writes it.
	function eventDate(startsAt: string): string {
		return new Date(startsAt).toLocaleDateString('en-US', {
			weekday: 'short',
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});
	}

	const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
</script>

<div class="mx-auto max-w-3xl px-6 py-8 sm:py-12">
	{#if declared}
		<div class="mb-6">
			<a
				href={resolve('/(app)/groups')}
				class="text-accent-600 hover:text-accent-700 dark:text-accent-400 dark:hover:text-accent-300 text-sm font-medium transition-colors"
			>
				&larr; All groups
			</a>
		</div>
	{/if}
	<h1 class="text-base-900 dark:text-base-50 text-2xl font-bold">
		{data.server ? `Groups at ${data.server.host}` : 'Groups'}
	</h1>
	{#if !declared}
		<p class="text-base-700 dark:text-base-300 mt-2">
			A group is a community with its own page that others can find and ask to join, where its
			admins post as the group. Group events are made from the group's page, as the group.
		</p>
	{/if}

	{#if data.notice}
		<p role="status" class="text-base-600 dark:text-base-400 mt-4 text-sm">{data.notice}</p>
	{/if}

	<form method="GET" action={resolve('/(app)/groups')} role="search" class="mt-6">
		<Label for="group-search">
			{data.server ? `Search the groups at ${data.server.host}` : 'Search groups'}
		</Label>
		<div class="mt-1 flex flex-wrap items-center gap-2">
			{#if data.server}
				<input type="hidden" name="server" value={data.server.origin} />
			{/if}
			<div class="min-w-0 flex-1">
				<Input
					id="group-search"
					name="q"
					type="search"
					value={data.q ?? ''}
					maxlength={64}
					placeholder="Search by address or name"
				/>
			</div>
			<Button type="submit" variant="secondary">Search</Button>
		</div>
		<p class="text-base-600 dark:text-base-400 mt-1 text-sm">
			Finds a listed group by its address, or by its name where atmo has it.
		</p>
	</form>

	{#if data.canLink}
		{#if data.newGroupUrl}
			<!-- The group host's own page, in a new tab that can't reach back. -->
			<div class="mt-6 flex flex-wrap items-center gap-3">
				<!-- eslint-disable svelte/no-navigation-without-resolve -->
				<Button href={data.newGroupUrl} target="_blank" rel="noopener noreferrer" variant="primary"
					>Make a group <span aria-hidden="true">&nearr;</span></Button
				><!-- eslint-enable svelte/no-navigation-without-resolve -->
				<span class="text-base-600 dark:text-base-400 text-sm">
					Make the group at the group host, then link it here.
				</span>
			</div>
		{/if}
		<form method="POST" action="/oauth/group/link" class="mt-6 flex flex-wrap items-end gap-2">
			<div class="min-w-0 flex-1">
				<Label for="group-link">Link a group you help run, to post its events</Label>
				<Input id="group-link" name="group" placeholder="group.example.com" required />
			</div>
			<Button type="submit" variant="secondary">Link</Button>
		</form>
	{/if}

	{#if data.linked.length > 0}
		<section class="mt-8" aria-labelledby="linked-groups">
			<h2 id="linked-groups" class="text-base-900 dark:text-base-50 text-lg font-semibold">
				Groups you've linked
			</h2>
			<ul class="divide-base-200 dark:divide-base-800 mt-2 divide-y">
				{#each data.linked as group (group.did)}
					<li>
						<a
							href={resolve('/(app)/groups/[actor]', { actor: group.did })}
							class="hover:bg-base-100 dark:hover:bg-base-900/50 -mx-2 flex items-center gap-3 rounded-lg px-2 py-3 transition-colors"
						>
							<Avatar name={group.name} size={32} />
							<span class="min-w-0 flex-1">
								<span class="text-base-900 dark:text-base-50 flex items-center gap-2 font-medium">
									<span class="truncate">{group.name}</span>
									<Badge>Linked</Badge>
								</span>
								{#if group.handle}
									<span class="text-base-600 dark:text-base-400 block truncate text-sm"
										>@{group.handle}</span
									>
								{/if}
							</span>
						</a>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if data.unavailable}
		<p class="text-base-600 dark:text-base-400 mt-6 text-sm">
			The groups list could not be loaded. Try again shortly.
		</p>
	{/if}

	<!-- eslint-disable svelte/no-navigation-without-resolve -->
	{#if declared}
		{#if data.q}
			<h2 class="text-base-900 dark:text-base-50 mt-8 text-lg font-semibold">
				Groups matching “{data.q}”
			</h2>
		{/if}
		{#if data.groups.length > 0}
			<ul class="divide-base-200 dark:divide-base-800 mt-4 divide-y">
				{#each data.groups as group (group.did)}
					<li>
						<a
							href={resolve('/(app)/groups/[actor]', { actor: group.did })}
							class="hover:bg-base-100 dark:hover:bg-base-900/50 -mx-2 flex items-start gap-3 rounded-lg px-2 py-3 transition-colors"
						>
							<Avatar name={group.name} size={40} />
							<span class="min-w-0 flex-1">
								<span class="text-base-900 dark:text-base-50 block truncate font-medium"
									>{group.name}</span
								>
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
		{:else if !data.unavailable}
			<p class="text-base-600 dark:text-base-400 py-12 text-center">
				{data.q ? 'No group matches that.' : 'No groups at this server yet.'}
			</p>
		{/if}
		{#if moreUrl}
			<a
				href={moreUrl}
				class="text-accent-600 hover:text-accent-700 dark:text-accent-400 dark:hover:text-accent-300 mt-6 inline-block text-sm font-medium transition-colors"
				>More groups &rarr;</a
			>
		{/if}
	{:else}
		<section class="mt-8" aria-labelledby="upcoming">
			<h2 id="upcoming" class="text-base-900 dark:text-base-50 text-lg font-semibold">
				Groups with events coming up
			</h2>
			{#if data.upcoming.length > 0}
				<ul class="divide-base-200 dark:divide-base-800 mt-2 divide-y">
					{#each data.upcoming as group (group.did)}
						<li>
							<a
								href={resolve('/(app)/groups/[actor]', { actor: group.did })}
								class="hover:bg-base-100 dark:hover:bg-base-900/50 -mx-2 flex items-start gap-3 rounded-lg px-2 py-3 transition-colors"
							>
								<Avatar name={group.name} size={40} />
								<span class="min-w-0 flex-1">
									<span class="text-base-900 dark:text-base-50 block truncate font-medium"
										>{group.name}</span
									>
									{#if group.handle && group.handle !== group.name}
										<span class="text-base-600 dark:text-base-400 block truncate text-sm"
											>@{group.handle}</span
										>
									{/if}
									<span class="text-base-700 dark:text-base-300 mt-1 block truncate text-sm">
										{#if group.next.title}{group.next.title} &middot;
										{/if}<time datetime={group.next.startsAt}>{eventDate(group.next.startsAt)}</time
										>
									</span>
								</span>
							</a>
						</li>
					{/each}
				</ul>
			{:else if !data.unavailable}
				<p class="text-base-600 dark:text-base-400 mt-2 text-sm">
					No group has an event coming up. Search finds every group, and each server's page lists
					all of its own.
				</p>
			{/if}
			{#if moreUrl}
				<a
					href={moreUrl}
					class="text-accent-600 hover:text-accent-700 dark:text-accent-400 dark:hover:text-accent-300 mt-6 inline-block text-sm font-medium transition-colors"
					>More groups &rarr;</a
				>
			{/if}
		</section>

		{#if data.servers.length > 0}
			<section class="mt-8" aria-labelledby="by-server">
				<h2 id="by-server" class="text-base-900 dark:text-base-50 text-lg font-semibold">
					Groups by server
				</h2>
				<p class="text-base-600 dark:text-base-400 mt-1 text-sm">
					The list above shows up to 15 groups from any one server on a page, and only groups with
					an event coming up. Each server's page lists all of its groups.
				</p>
				<ul class="divide-base-200 dark:divide-base-800 mt-2 divide-y text-sm">
					{#each data.servers as entry (entry.server)}
						<li class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3">
							<span class="min-w-0">
								<span class="text-base-900 dark:text-base-50 font-medium">{entry.host}</span>
								<span class="text-base-600 dark:text-base-400">
									{count(entry.groups, 'group', 'groups')}, {entry.upcoming} with events coming up
								</span>
							</span>
							<a
								href={listUrl({ server: entry.server })}
								aria-label={`See all groups at ${entry.host}`}
								class="text-accent-600 hover:text-accent-700 dark:text-accent-400 dark:hover:text-accent-300 font-medium transition-colors"
								>See all &rarr;</a
							>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	{/if}
	<!-- eslint-enable svelte/no-navigation-without-resolve -->
</div>
