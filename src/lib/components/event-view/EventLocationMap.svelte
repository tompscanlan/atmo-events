<script lang="ts">
	import Map from '$lib/components/Map.svelte';
	import type { LocationData } from './format';

	let {
		locationData,
		geoLocation
	}: {
		locationData: LocationData | null;
		geoLocation: { lat: number; lng: number } | null;
	} = $props();
</script>

{#if geoLocation && locationData}
	<div class="mt-8 mb-8">
		<p
			class="text-base-500 dark:text-base-400 mb-3 text-xs font-semibold tracking-wider uppercase"
		>
			Location
		</p>
		<a
			href={locationData.mapsUrl}
			target="_blank"
			rel="noopener noreferrer"
			class="block transition-opacity hover:opacity-80"
		>
			<div class="h-64 w-full overflow-hidden rounded-xl">
				<Map lat={geoLocation.lat} lng={geoLocation.lng} />
			</div>
			<p class="text-base-500 dark:text-base-400 mt-2 text-sm">
				{locationData.fullString}
			</p>
		</a>
	</div>
{/if}
