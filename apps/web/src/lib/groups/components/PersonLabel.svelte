<script lang="ts">
	import { Avatar, cn } from '@foxui/core';
	import { resolve } from '$app/paths';
	import type { Person } from '../types';

	// A DID shown as a person: avatar, display name, handle. The link is the
	// person's page on this site, keyed by the DID like every link the app
	// publishes. With no handle the DID is shown, since it is the one name
	// that always resolves.
	let {
		did,
		person,
		size = 'md',
		class: className
	}: {
		did: string;
		person?: Person;
		size?: 'sm' | 'md';
		class?: string;
	} = $props();

	let handle = $derived(person?.handle ?? null);
	let name = $derived(person?.displayName || handle || did);
</script>

<div class={cn('flex min-w-0 items-center gap-3', className)}>
	<Avatar src={person?.avatar ?? undefined} alt="" class={size === 'sm' ? 'size-8' : 'size-10'} />
	<div class="min-w-0">
		<a
			href={resolve('/(app)/p/[actor]', { actor: did })}
			class={cn(
				'block truncate font-medium hover:underline',
				size === 'sm' ? 'text-sm' : 'text-base',
				!person?.displayName && !handle && 'font-mono text-xs'
			)}
			title={did}>{name}</a
		>
		{#if person?.displayName && handle}
			<p class="text-base-500 dark:text-base-400 truncate text-xs">@{handle}</p>
		{:else if person?.displayName}
			<p class="text-base-400 dark:text-base-500 truncate font-mono text-xs">{did}</p>
		{/if}
	</div>
</div>
