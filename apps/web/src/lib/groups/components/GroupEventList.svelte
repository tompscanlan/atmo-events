<script lang="ts">
	import { EventCard, type FlatEventRecord } from '@atmo-dev/events-ui';
	import { resolve } from '$app/paths';
	import type { GroupEventRecord } from '$lib/groups/types';

	let {
		groupDid,
		events,
		canManageEvents = false
	}: { groupDid: string; events: GroupEventRecord[]; canManageEvents?: boolean } = $props();

	// `did` is the group's, so the card links to the group's event page. A members-only event
	// keeps its space, so its card shows the lock.
	function toCard(event: GroupEventRecord): FlatEventRecord {
		return {
			...(event.value as unknown as FlatEventRecord),
			did: groupDid,
			rkey: event.rkey,
			uri: event.uri,
			cid: event.cid || null,
			...(event.space ? { space: event.space } : {})
		};
	}

	// A public and a members-only event can share a key, and the edit page reads the index
	// unless the link says otherwise.
	function editPage(event: GroupEventRecord): string {
		const path = resolve('/(app)/groups/[actor]/events/[rkey]/edit', {
			actor: groupDid,
			rkey: event.rkey
		});
		return event.space ? `${path}?placement=members` : path;
	}

	// The card's own link reads the index, which never holds a members-only event.
	function membersOnlyPage(event: GroupEventRecord): string | undefined {
		if (!event.space) return undefined;
		return resolve('/(app)/groups/[actor]/events/[rkey]', { actor: groupDid, rkey: event.rkey });
	}
</script>

<div class="flex flex-col gap-6">
	<!-- Keyed by URI: a public and a members-only event can share an rkey. -->
	{#each events as event (event.uri)}
		<div>
			<EventCard
				event={toCard(event)}
				actor={groupDid}
				href={membersOnlyPage(event)}
				lockLabel="Members only"
			/>
			{#if canManageEvents}
				<!-- editPage resolves the path; a query string cannot go through resolve(). -->
				<!-- eslint-disable svelte/no-navigation-without-resolve -->
				<a
					href={editPage(event)}
					class="text-base-500 dark:text-base-400 mt-2 inline-block text-sm hover:underline">Edit</a
				>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
			{/if}
		</div>
	{/each}
</div>
