<script lang="ts">
	import { Button } from '@foxui/core';
	import { EventCard, type FlatEventRecord } from '@atmo-dev/events-ui';
	import type { GroupEventRecord } from '$lib/groups/types';
	import PdslsLink from '$lib/groups/components/PdslsLink.svelte';
	import { resolve } from '$app/paths';

	let { data } = $props();

	let group = $derived(data.group);
	// The loader reads the group's name from the about space, not from a column,
	// so this tab shows the same name as the group page.
	let groupName = $derived(data.groupName);

	/** The group's records as the cards the rest of the app uses. `did` is the
	 *  group's, so the card links to the group's event page, not an admin's. A
	 *  members-only event keeps its space, so its card shows the lock. */
	function toCard(event: GroupEventRecord): FlatEventRecord {
		return {
			...(event.value as unknown as FlatEventRecord),
			did: group.group_did,
			rkey: event.rkey,
			uri: event.uri,
			cid: event.cid || null,
			...(event.space ? { space: event.space } : {})
		};
	}

	/** The edit page of one of the group's events. A members-only event's link
	 *  names its placement, because a public event can share its key and the
	 *  edit page reads the index unless told otherwise. */
	function editPage(event: GroupEventRecord): string {
		const path = resolve('/(app)/groups/[actor]/events/[rkey]/edit', {
			actor: group.group_did,
			rkey: event.rkey
		});
		return event.space ? `${path}?placement=members` : path;
	}

	/** A members-only event's own page, at its key under the group. The card's
	 *  default link is the public event page, which reads the index, and the
	 *  index never holds a members-only event. Undefined for a public event, so
	 *  its card links as every other card does. */
	function membersOnlyPage(event: GroupEventRecord): string | undefined {
		if (!event.space) return undefined;
		return resolve('/(app)/groups/[actor]/events/[rkey]', {
			actor: group.group_did,
			rkey: event.rkey
		});
	}
</script>

<svelte:head><title>{groupName} events - atmo.rsvp</title></svelte:head>

<div class="mx-auto max-w-3xl px-6 py-8 sm:py-12">
	<a
		href={resolve('/(app)/groups/[actor]', { actor: group.group_did })}
		class="text-base-500 dark:text-base-400 mb-4 inline-block text-sm hover:underline"
		>← {groupName}</a
	>

	<div class="mb-2 flex flex-wrap items-center justify-between gap-4">
		<h1 class="text-3xl font-bold">Events</h1>
		{#if data.canCreateEvent}
			<!-- atmo's own event editor, publishing as the group. -->
			<Button href={resolve('/(app)/groups/[actor]/events/new', { actor: group.group_did })}
				>New group event</Button
			>
		{/if}
	</div>
	<p class="text-base-500 dark:text-base-400 mb-8 text-sm">
		Published as
		<PdslsLink
			to={group.group_did}
			title="The group's account on pds.ls"
			class="font-mono hover:underline"
			>{data.handle ? `@${data.handle}` : group.group_did}</PdslsLink
		>. The group is the author, not whoever pressed the button.
	</p>

	{#if data.membersOnlyNotice}
		<!-- Only a roster member's data carries this: the public slice is all they
		     see until the members-only events can be read again. -->
		<p
			class="border-base-200 dark:border-base-800 text-base-600 dark:text-base-300 mb-6 rounded-lg border px-4 py-3 text-sm"
			role="status"
		>
			{data.membersOnlyNotice}
		</p>
	{/if}

	{#if data.events.length === 0}
		<div class="py-16 text-center">
			<p class="text-base-500 dark:text-base-400 text-lg">This group has no public events yet.</p>
		</div>
	{:else}
		<div class="flex flex-col gap-6">
			<!-- Keyed by URI: a public and a members-only event can share an rkey. -->
			{#each data.events as event (event.uri)}
				<div>
					<!-- The lock shows only on a members-only card, and in the app's own
					     words: contrail's label is for its own spaces. (Spec: FR-108.) -->
					<EventCard
						event={toCard(event)}
						actor={group.group_did}
						href={membersOnlyPage(event)}
						lockLabel="Members only"
					/>
					<div class="mt-2 flex items-center gap-3">
						<!-- Any MANAGE_EVENTS holder edits any event here: they are all the
						     group's records, not each admin's. -->
						{#if data.canManageEvents}
							<!-- editPage resolves the path; a query string cannot go through resolve(). -->
							<!-- eslint-disable svelte/no-navigation-without-resolve -->
							<a
								href={editPage(event)}
								class="text-base-500 dark:text-base-400 text-sm hover:underline">Edit</a
							>
							<!-- eslint-enable svelte/no-navigation-without-resolve -->
						{/if}
						{#if event.space}
							<!-- No outside link: pds.ls is a third party, and the link would
							     hand it the calendar space's URI. -->
							<span class="text-base-400 dark:text-base-500 text-xs">members-only</span>
						{:else}
							<PdslsLink
								to={event.uri}
								title="This event's record on pds.ls"
								class="text-base-400 dark:text-base-500 text-xs hover:underline">record ↗</PdslsLink
							>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>
