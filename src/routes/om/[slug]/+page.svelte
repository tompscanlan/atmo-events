<script lang="ts">
	import { Badge } from '@foxui/core';
	import Avatar from 'svelte-boring-avatars';
	import { marked } from 'marked';
	import { sanitize } from '$lib/cal/sanitize';
	import { formatMonth, formatDay, formatWeekday, formatFullDate, formatTime } from '$lib/cal/helper';
	import OpenMeetRsvp from './OpenMeetRsvp.svelte';

	let { data } = $props();
	let event = $derived(data.event);

	let startDate = $derived(new Date(event.startDate));
	let endDate = $derived(event.endDate ? new Date(event.endDate) : null);

	function getModeLabel(type: string): string {
		if (type === 'online') return 'Virtual';
		if (type === 'hybrid') return 'Hybrid';
		return 'In-Person';
	}

	function getModeColor(type: string): 'cyan' | 'purple' | 'amber' | 'secondary' {
		if (type === 'online') return 'cyan';
		if (type === 'hybrid') return 'purple';
		if (type === 'in-person' || type === 'in_person') return 'amber';
		return 'secondary';
	}

	let isSameDay = $derived(
		endDate &&
			startDate.getFullYear() === endDate.getFullYear() &&
			startDate.getMonth() === endDate.getMonth() &&
			startDate.getDate() === endDate.getDate()
	);

	let descriptionHtml = $derived(
		event.description ? sanitize(marked.parse(event.description) as string) : null
	);
</script>

<svelte:head>
	<title>{event.name}</title>
	<meta name="description" content={event.description || `Event: ${event.name}`} />
</svelte:head>

<div class="min-h-screen px-6 py-12 sm:py-12">
	<div class="mx-auto max-w-3xl">
		<div
			class="grid grid-cols-1 gap-8 md:grid-cols-[14rem_1fr] md:grid-rows-[auto_1fr] md:gap-x-10 md:gap-y-6 lg:grid-cols-[16rem_1fr]"
		>
			<!-- Left column: image -->
			<div class="order-1 max-w-sm md:order-0 md:col-start-1 md:max-w-none">
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
							size={256}
							name={event.slug}
							variant="marble"
							colors={['#92A1C6', '#146A7C', '#F0AB3D', '#C271B4', '#C20D90']}
							square
						/>
					</div>
				{/if}
			</div>

			<!-- Right column: event details -->
			<div class="order-2 min-w-0 md:order-0 md:col-start-2 md:row-span-2 md:row-start-1">
				<div class="mb-2">
					<h1
						class="text-base-900 dark:text-base-50 text-4xl leading-tight font-bold sm:text-5xl"
					>
						{event.name}
					</h1>
				</div>

				<!-- Badges -->
				<div class="mb-8 flex gap-2">
					<Badge size="md" variant={getModeColor(event.type)}>{getModeLabel(event.type)}</Badge>
					<Badge size="md" variant="secondary">{event.visibility}</Badge>
					{#if event.group}
						<Badge size="md" variant="secondary">{event.group.name}</Badge>
					{/if}
				</div>

				<!-- Date row -->
				<div class="mb-4 flex items-center gap-4">
					<div
						class="border-base-200 dark:border-base-700 bg-base-100 dark:bg-base-950/30 flex size-12 shrink-0 flex-col items-center justify-center overflow-hidden rounded-xl border"
					>
						<span
							class="text-base-500 dark:text-base-400 text-[9px] leading-none font-semibold"
						>
							{formatMonth(startDate)}
						</span>
						<span class="text-base-900 dark:text-base-50 text-lg leading-tight font-bold">
							{formatDay(startDate)}
						</span>
					</div>
					<div>
						<p class="text-base-900 dark:text-base-50 font-semibold">
							{formatWeekday(startDate)}, {formatFullDate(startDate)}
							{#if endDate && !isSameDay}
								- {formatWeekday(endDate)}, {formatFullDate(endDate)}
							{/if}
						</p>
						<p class="text-base-500 dark:text-base-400 text-sm">
							{formatTime(startDate)}
							{#if endDate && isSameDay}
								- {formatTime(endDate)}
							{/if}
						</p>
					</div>
				</div>

				<!-- Location -->
				{#if event.location}
					<a
						href="https://www.google.com/maps/search/?api=1&query={encodeURIComponent(event.location)}"
						target="_blank"
						rel="noopener noreferrer"
						class="mb-6 flex items-center gap-4 transition-opacity hover:opacity-80"
					>
						<div
							class="border-base-200 dark:border-base-700 bg-base-100 dark:bg-base-950/30 flex size-12 shrink-0 items-center justify-center rounded-xl border"
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								fill="none"
								viewBox="0 0 24 24"
								stroke-width="1.5"
								stroke="currentColor"
								class="text-base-900 dark:text-base-200 size-5"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
								/>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z"
								/>
							</svg>
						</div>
						<p class="text-base-900 dark:text-base-50 font-semibold">{event.location}</p>
					</a>
				{/if}

				<!-- Attendees count -->
				{#if event.attendeesCount > 0}
					<p class="text-base-500 dark:text-base-400 mb-6 text-sm">
						{event.attendeesCount} attendee{event.attendeesCount !== 1 ? 's' : ''}
						{#if event.userRsvpStatus}
							&middot; You're {event.userRsvpStatus}
						{/if}
					</p>
				{/if}

				<!-- RSVP -->
				<OpenMeetRsvp userRsvpStatus={event.userRsvpStatus} />

				<!-- Description -->
				{#if descriptionHtml}
					<div class="mt-8 mb-8">
						<p
							class="text-base-500 dark:text-base-400 mb-3 text-xs font-semibold tracking-wider uppercase"
						>
							About
						</p>
						<div
							class="text-base-700 dark:text-base-300 prose dark:prose-invert max-w-none leading-relaxed wrap-break-word"
						>
							{@html descriptionHtml}
						</div>
					</div>
				{/if}
			</div>

			<!-- Left column: sidebar -->
			<div class="order-3 space-y-6 md:order-0 md:col-start-1">
				{#if event.group}
					<div>
						<p
							class="text-base-500 dark:text-base-400 mb-3 text-xs font-semibold tracking-wider uppercase"
						>
							Group
						</p>
						<p class="text-base-900 dark:text-base-50 text-sm font-medium">
							{event.group.name}
						</p>
						<p class="text-base-500 text-xs">Your role: {event.group.role}</p>
					</div>
				{/if}
			</div>
		</div>
	</div>
</div>
