<script lang="ts">
	import { cn } from '@foxui/core';

	// The group's picture when the page could read one, else its initial.
	let {
		name,
		src = null,
		class: className
	}: { name: string; src?: string | null; class?: string } = $props();

	let initial = $derived(Array.from(name.trim())[0]?.toUpperCase() ?? '?');
</script>

{#if src}
	<img {src} alt="" class={cn('size-12 shrink-0 rounded-2xl object-cover', className)} />
{:else}
	<div
		aria-hidden="true"
		class={cn(
			'bg-accent-500/15 text-accent-700 dark:bg-accent-500/20 dark:text-accent-300 grid size-12 shrink-0 place-items-center rounded-2xl font-bold',
			className
		)}
	>
		{initial}
	</div>
{/if}
