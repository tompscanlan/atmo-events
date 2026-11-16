<script lang="ts">
	import PrivateEventPage from '#lib/private-events/components/PrivateEventPage.svelte';

	let { data } = $props();
</script>

<PrivateEventPage
	{data}
	hostPurpose="Your sign-in no longer lets atmo open your private events. Allow it again to see this one and who is coming."
/>
