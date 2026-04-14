<script lang="ts">
	import EventView from '$lib/components/EventView.svelte';
	let { data } = $props();
</script>

<EventView {data} />
