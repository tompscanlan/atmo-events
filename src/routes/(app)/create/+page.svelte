<script lang="ts">
	import EventEditor from '$lib/components/EventEditor.svelte';
	import { page } from '$app/state';

	let { data } = $props();
	let privateMode = $derived(page.url.searchParams.get('private') === '1');
</script>

<svelte:head>
	<title>Create Event</title>
</svelte:head>

<EventEditor eventData={null} actorDid={data.actorDid} rkey={data.rkey} {privateMode} />
