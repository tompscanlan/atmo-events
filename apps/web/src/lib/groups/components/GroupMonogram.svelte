<script lang="ts">
	import { cn } from '@foxui/core';

	// A group has no picture yet, so its tile is its initial.
	let { name, class: className }: { name: string; class?: string } = $props();

	let initial = $derived(Array.from(name.trim())[0]?.toUpperCase() ?? '?');
</script>

<div
	aria-hidden="true"
	class={cn(
		'bg-accent-500/15 text-accent-700 dark:bg-accent-500/20 dark:text-accent-300 grid size-12 shrink-0 place-items-center rounded-2xl font-bold',
		className
	)}
>
	{initial}
</div>
