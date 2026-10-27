<script lang="ts">
	import { Avatar as FoxAvatar } from '@foxui/core';
	import type { EventHost, HostProfile } from '../contrail.js';

	type Speaker = { id?: string; handle?: string; name: string; avatar?: string };

	let {
		hostProfile,
		hostUrl,
		host = null,
		did,
		speakers = []
	}: {
		hostProfile: HostProfile | null | undefined;
		hostUrl: string;
		host?: EventHost | null;
		did: string;
		speakers?: Speaker[];
	} = $props();

	let name = $derived(host?.name ?? (hostProfile?.displayName || hostProfile?.handle || did));
	let href = $derived(host ? host.href : hostUrl);
</script>

{#snippet face()}
	<FoxAvatar src={hostProfile?.avatar} alt={name} class="size-8 shrink-0" />
	<span class="min-w-0">
		<span class="block truncate text-sm">{name}</span>
		{#if host?.note}
			<span class="text-base-500 dark:text-base-400 block text-xs font-normal">{host.note}</span>
		{/if}
	</span>
{/snippet}

<div>
	<p class="text-base-500 dark:text-base-400 mb-3 text-xs font-semibold tracking-wider uppercase">
		Hosted By
	</p>
	{#if href}
		<a
			{href}
			class="text-base-900 dark:text-base-100 flex items-center gap-2.5 font-medium transition-opacity hover:opacity-80"
		>
			{@render face()}
		</a>
	{:else}
		<div class="text-base-900 dark:text-base-100 flex items-center gap-2.5 font-medium">
			{@render face()}
		</div>
	{/if}
</div>

{#if speakers.length > 0}
	<div>
		<p class="text-base-500 dark:text-base-400 mb-3 text-xs font-semibold tracking-wider uppercase">
			Speakers
		</p>
		<div class="space-y-2">
			{#each speakers as speaker, i (speaker.id || i)}
				{#if speaker.handle}
					<a
						href="https://bsky.app/profile/{speaker.handle}"
						target="_blank"
						rel="noopener noreferrer"
						class="text-base-900 dark:text-base-100 flex items-center gap-2.5 font-medium transition-opacity hover:opacity-80"
					>
						<FoxAvatar src={speaker.avatar} alt={speaker.name} class="size-8 shrink-0" />
						<span class="truncate text-sm">{speaker.name}</span>
					</a>
				{:else}
					<div class="text-base-900 dark:text-base-100 flex items-center gap-2.5 font-medium">
						<FoxAvatar alt={speaker.name} class="size-8 shrink-0" />
						<span class="truncate text-sm">{speaker.name}</span>
					</div>
				{/if}
			{/each}
		</div>
	</div>
{/if}
