<script lang="ts">
	import CalendarsNeedAllowing from '#lib/private-events/components/CalendarsNeedAllowing.svelte';
	import FindAgainOffer from '#lib/private-events/components/FindAgainOffer.svelte';
	import GuestList from '#lib/private-events/components/GuestList.svelte';
	import PrivateEventPage from '#lib/private-events/components/PrivateEventPage.svelte';
	import SaveAsCalendar from '#lib/private-events/components/SaveAsCalendar.svelte';

	let { data } = $props();
</script>

<!-- Once its host names its space, it is on that calendar, at the address it always had. -->
<PrivateEventPage
	{data}
	hostPurpose="Your sign-in no longer lets atmo open your private events. Allow it again to see this one and its guest list."
>
	{#snippet apart(answered)}
		{#if data.view === 'event'}
			{#if data.guests}
				<GuestList rkey={data.rkey} guests={data.guests} capped={data.guestsCapped} />
				{#if data.canName}<SaveAsCalendar spaceKey={data.rkey} />{:else}<CalendarsNeedAllowing
					/>{/if}
			{:else}
				<p class="text-base-600 dark:text-base-400 text-sm" data-testid="private-note">
					Private event. Only people the host added can see it.
					{#if !answered && !data.answersUnread}Answer to let the host know you saw it.{/if}
				</p>
				{#if answered}<FindAgainOffer onCalendar={false} />{/if}
			{/if}
		{/if}
	{/snippet}
</PrivateEventPage>
