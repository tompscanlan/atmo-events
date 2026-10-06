<script lang="ts">
	import { EventEditor } from '@atmo-dev/events-ui';
	import { user } from '$lib/atproto/auth.svelte';
	import { createGroupEditorAdapter } from '$lib/groups/editor-adapter';

	let { data } = $props();

	// The group is the viewer: the editor shows it as the host, and every save
	// lands in its repo.
	let viewer = $derived({
		isLoggedIn: user.isLoggedIn,
		did: data.groupDid,
		handle: data.handle ?? undefined,
		displayName: data.groupName
	});
	// Public: this page offers no members-only choice yet.
	let adapter = $derived(
		createGroupEditorAdapter({
			groupDid: data.groupDid,
			editingRkey: null,
			canDelete: false,
			space: null
		})
	);
</script>

<svelte:head>
	<title>New event for {data.groupName}</title>
</svelte:head>

<EventEditor eventData={null} actorDid={data.groupDid} rkey={data.rkey} {adapter} {viewer} />
