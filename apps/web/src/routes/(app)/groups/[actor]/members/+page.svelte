<script lang="ts">
	import { Avatar, Badge } from '@atmo-dev/kit';
	import { resolve } from '$app/paths';

	let { data } = $props();

	const label = (did: string) => (data.hidden ? did : (data.handles[did] ?? did));
</script>

<div class="min-h-screen px-6 py-12 sm:py-12">
	<div class="mx-auto max-w-2xl">
		<div class="mb-6">
			<a
				href={resolve('/(app)/groups/[actor]', { actor: data.group.did })}
				class="text-accent-600 hover:text-accent-700 dark:text-accent-400 dark:hover:text-accent-300 text-sm font-medium transition-colors"
			>
				&larr; {data.group.name}
			</a>
		</div>

		<h1 class="text-base-900 dark:text-base-50 text-2xl font-bold">Members</h1>

		{#if data.hidden}
			<p class="text-muted mt-6">Only members can see who is in this group.</p>
		{:else}
			{#if data.role}<p class="text-muted mt-2 text-sm">You are a {data.role}.</p>{/if}

			<ul class="mt-6 space-y-2">
				{#each data.listed as entry (entry.did)}
					<li class="flex items-center gap-3">
						<Avatar name={label(entry.did)} size={32} />
						<a
							href={resolve('/(app)/p/[actor]', { actor: entry.did })}
							class="text-base-900 dark:text-base-50 min-w-0 flex-1 truncate">{label(entry.did)}</a
						>
						{#if entry.role !== 'member'}<Badge>{entry.role}</Badge>{/if}
					</li>
				{/each}
			</ul>

			{#if data.unconfirmed.length > 0}
				<h2 class="text-base-900 dark:text-base-50 mt-10 text-lg font-semibold">
					Not confirmed yet
				</h2>
				<p class="text-muted text-sm">
					Added, but they have not visited the group since. Only people who can admit members see
					this list.
				</p>
				<ul class="mt-4 space-y-2">
					{#each data.unconfirmed as entry (entry.did)}
						<li class="flex items-center gap-3">
							<Avatar name={label(entry.did)} size={32} />
							<span class="text-muted min-w-0 flex-1 truncate">{label(entry.did)}</span>
							{#if entry.role !== 'member'}<Badge>{entry.role}</Badge>{/if}
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</div>
</div>
