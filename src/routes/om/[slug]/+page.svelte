<script lang="ts">
	import { Avatar as FoxAvatar, Badge } from '@foxui/core';
	import { marked } from 'marked';
	import { sanitize } from '$lib/cal/sanitize';
	import EventDetail from '$lib/components/EventDetail.svelte';
	import OpenMeetRsvp from './OpenMeetRsvp.svelte';

	let { data } = $props();

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
</script>

<svelte:head>
	{#if data.event}
		<title>{data.event.name}</title>
		<meta name="description" content={data.event.description || `Event: ${data.event.name}`} />
	{:else}
		<title>Event</title>
	{/if}
</svelte:head>

{#if data.state === 'ok' && data.event}
	{@const event = data.event}
	{@const descriptionHtml = event.description
		? sanitize(marked.parse(event.description) as string)
		: null}
	{@const location = event.location
		? {
				text: event.location,
				mapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(event.location)}`
			}
		: null}

	<EventDetail
		name={event.name}
		image={event.image}
		avatarSeed={event.slug}
		startDate={new Date(event.startDate)}
		endDate={event.endDate ? new Date(event.endDate) : null}
		{descriptionHtml}
		{location}
	>
		{#snippet badges()}
			<Badge size="md" variant={getModeColor(event.type)}>{getModeLabel(event.type)}</Badge>
			<Badge size="md" variant="secondary">{event.visibility}</Badge>
			{#if event.group}
				<Badge size="md" variant="secondary">{event.group.name}</Badge>
			{/if}
		{/snippet}

		{#snippet rsvp()}
			{#if event.attendeesCount > 0}
				<p class="text-base-500 dark:text-base-400 mb-6 text-sm">
					{event.attendeesCount} attendee{event.attendeesCount !== 1 ? 's' : ''}
					{#if event.userRsvpStatus}
						&middot; You're {event.userRsvpStatus}
					{/if}
				</p>
			{/if}
			<OpenMeetRsvp userRsvpStatus={event.userRsvpStatus} />
		{/snippet}

		{#snippet sidebar()}
			<!-- Hosted By -->
			{#if event.user}
				<div>
					<p
						class="text-base-500 dark:text-base-400 mb-3 text-xs font-semibold tracking-wider uppercase"
					>
						Hosted By
					</p>
					<div
						class="text-base-900 dark:text-base-100 flex items-center gap-2.5 font-medium"
					>
						<FoxAvatar
							src={event.user.photo?.path}
							alt={event.user.name}
							class="size-8 shrink-0"
						/>
						<span class="truncate text-sm">{event.user.name}</span>
					</div>
				</div>
			{/if}

			<!-- Group -->
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

			<!-- Attendees -->
			{#if event.attendees && event.attendees.length > 0}
				<div>
					<p
						class="text-base-500 dark:text-base-400 mb-3 text-xs font-semibold tracking-wider uppercase"
					>
						Attendees
					</p>
					<div class="space-y-2">
						{#each event.attendees as attendee (attendee.id)}
							<div
								class="text-base-900 dark:text-base-100 flex items-center gap-2.5 font-medium"
							>
								<FoxAvatar
									src={attendee.user.photo?.path}
									alt={attendee.user.name}
									class="size-8 shrink-0"
								/>
								<div class="min-w-0">
									<span class="truncate text-sm">{attendee.user.name}</span>
									{#if attendee.role && attendee.role.name !== 'attendee'}
										<span class="text-base-500 dark:text-base-400 ml-1 text-xs">
											({attendee.role.name})
										</span>
									{/if}
								</div>
							</div>
						{/each}
						{#if event.attendeesCount > event.attendees.length}
							<p class="text-base-500 dark:text-base-400 text-xs">
								+{event.attendeesCount - event.attendees.length} more
							</p>
						{/if}
					</div>
				</div>
			{/if}
		{/snippet}
	</EventDetail>
{:else}
	<div class="px-6 py-24 text-center">
		{#if data.state === 'unauthenticated'}
			<p class="text-base-500 dark:text-base-400">Sign in to see non-public events.</p>
		{:else}
			<p class="text-base-500 dark:text-base-400">
				This event doesn't exist or you don't have access.
			</p>
		{/if}
	</div>
{/if}
