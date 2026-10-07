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
	// The server's own words when it refuses a save, a delete or an upload. The
	// editor shows only its generic line, from the shared package.
	let refusal = $state<string>();
	// Public: this page offers no members-only choice yet.
	let adapter = $derived(
		createGroupEditorAdapter({
			groupDid: data.groupDid,
			editingRkey: null,
			canDelete: false,
			space: null,
			onRefusal: (message) => (refusal = message)
		})
	);
</script>

<svelte:head>
	<title>New event for {data.groupName}</title>
</svelte:head>

{#if refusal}
	<div class="mx-auto max-w-3xl px-6 pt-8 sm:pt-12">
		<p class="text-sm text-red-600 dark:text-red-400" role="alert">{refusal}</p>
	</div>
{/if}

<EventEditor eventData={null} actorDid={data.groupDid} rkey={data.rkey} {adapter} {viewer} />
