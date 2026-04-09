<script lang="ts">
	// @ts-nocheck
	import { designs } from './thumbnails/designs';
	import { tick } from 'svelte';

	let {
		name = '',
		dateStr = '',
		selected = $bindable<{ design: string; seed: number } | null>(null),
		onselect
	}: {
		name?: string;
		dateStr?: string;
		selected?: { design: string; seed: number } | null;
		onselect?: () => void;
	} = $props();

	const presetKeys = Object.keys(designs);
	const seeds = [0, 1, 2, 3];
	const previewSize = 200;

	let containerEl: HTMLDivElement | undefined = $state(undefined);

	function renderAll() {
		if (!containerEl) return;
		const canvases = containerEl.querySelectorAll<HTMLCanvasElement>('canvas');
		canvases.forEach((canvas) => {
			const key = canvas.dataset.key!;
			const seed = parseInt(canvas.dataset.seed!, 10);
			const ctx = canvas.getContext('2d');
			if (!ctx) return;
			canvas.width = previewSize;
			canvas.height = previewSize;
			designs[key](ctx, previewSize, previewSize, name || 'Event', dateStr, seed);
		});
	}

	$effect(() => {
		void name;
		void dateStr;
		void containerEl;
		tick().then(renderAll);
	});
</script>

<div class="flex flex-col gap-3">
	<p class="text-base-500 dark:text-base-400 text-xs font-medium">Preset thumbnails</p>
	<div class="grid grid-cols-4 gap-2" bind:this={containerEl}>
		{#each presetKeys as key}
			{#each seeds as seed}
				<button
					type="button"
					class="aspect-square cursor-pointer overflow-hidden rounded-xl border-2 transition-colors
						{selected?.design === key && selected?.seed === seed
						? 'border-accent-500'
						: 'border-base-200 dark:border-base-700 hover:border-accent-400 dark:hover:border-accent-500'}"
					onclick={() => { selected = { design: key, seed }; onselect?.(); }}
				>
					<canvas data-key={key} data-seed={seed} class="h-full w-full"></canvas>
				</button>
			{/each}
		{/each}
	</div>
</div>
