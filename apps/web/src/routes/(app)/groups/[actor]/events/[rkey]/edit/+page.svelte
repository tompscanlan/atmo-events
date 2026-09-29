<script lang="ts">
	import { EventEditor } from '@atmo-dev/events-ui';
	import { user } from '$lib/atproto/auth.svelte';
	import { createGroupEditorAdapter } from '$lib/groups/editor-adapter';

	let { data } = $props();

	// The group is the viewer, as on the new-event page.
	let viewer = $derived({
		isLoggedIn: user.isLoggedIn,
		did: data.groupDid,
		handle: data.handle ?? undefined,
		displayName: data.groupName
	});
	let adapter = $derived(
		createGroupEditorAdapter({
			groupDid: data.groupDid,
			editingRkey: data.rkey,
			canDelete: data.canDelete
		})
	);
</script>

<svelte:head>
	<title>Edit event - {data.groupName}</title>
</svelte:head>

<EventEditor
	eventData={data.eventData}
	actorDid={data.groupDid}
	rkey={data.rkey}
	{adapter}
	{viewer}
/>
