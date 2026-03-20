<script lang="ts">
	import type { OpenMeetEvent } from '$lib/openmeet/types';
	import Avatar from 'svelte-boring-avatars';

	let { event }: { event: OpenMeetEvent } = $props();

	function formatDateTime(dateStr: string): string {
		return new Date(dateStr).toLocaleDateString('en-US', {
			weekday: 'short',
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});
	}
</script>

<a
	href="/om/{event.slug}"
	class="group grid grid-cols-[4rem_1fr] gap-3 transition-colors sm:grid-cols-[5rem_1fr] sm:gap-4"
>
	<div class="w-full">
		{#if event.image}
			<img
				src={event.image}
				alt={event.name}
				class="border-base-200 dark:border-base-800 aspect-square w-full rounded-2xl border object-cover"
			/>
		{:else}
			<div
				class="border-base-200 dark:border-base-800 aspect-square w-full overflow-hidden rounded-2xl border [&>svg]:h-full [&>svg]:w-full"
			>
				<Avatar
					size={80}
					name={event.slug}
					variant="marble"
					colors={['#92A1C6', '#146A7C', '#F0AB3D', '#C271B4', '#C20D90']}
					square
				/>
			</div>
		{/if}
	</div>

	<div class="min-w-0 self-center">
		<p class="text-base-500 dark:text-base-400 flex items-center gap-1.5 text-xs font-medium">
			{formatDateTime(event.startDate)}
			{#if event.visibility !== 'public'}
				<span class="inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="size-2.5">
						<path fill-rule="evenodd" d="M8 1a3.5 3.5 0 0 0-3.5 3.5V7A1.5 1.5 0 0 0 3 8.5v5A1.5 1.5 0 0 0 4.5 15h7a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 11.5 7V4.5A3.5 3.5 0 0 0 8 1Zm2 6V4.5a2 2 0 1 0-4 0V7h4Z" clip-rule="evenodd" />
					</svg>
					Private
				</span>
			{/if}
		</p>
		<h3
			class="text-base-900 dark:text-base-50 group-hover:text-base-700 dark:group-hover:text-base-200 mt-0.5 line-clamp-2 text-sm leading-snug font-semibold transition-colors sm:text-base"
		>
			{event.name}
		</h3>
		{#if event.location || event.group}
			<p class="text-base-500 dark:text-base-400 mt-1 text-xs">
				{#if event.location}{event.location}{/if}
				{#if event.location && event.group}
					<span class="mx-1">&middot;</span>
				{/if}
				{#if event.group}{event.group.name}{/if}
			</p>
		{/if}
	</div>
</a>
