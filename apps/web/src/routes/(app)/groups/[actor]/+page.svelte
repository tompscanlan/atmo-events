<script lang="ts">
	import { resolve } from '$app/paths';
	import GroupSetupNotice from '$lib/groups/components/GroupSetupNotice.svelte';
	import GroupSignInNotice from '$lib/groups/components/GroupSignInNotice.svelte';
	import GroupPage from './GroupPage.svelte';

	let { data } = $props();
</script>

<!-- GroupPage sets its own head. -->
<svelte:head>
	{#if data.signInOnly || data.setupUnfinished}<title>{data.groupName} - atmo.rsvp</title>{/if}
</svelte:head>

{#if data.signInOnly}
	<!-- Hidden until a new sign-in: nothing of the group was read, so only its address. -->
	<div class="mx-auto max-w-3xl px-6 py-8 sm:py-12">
		<a
			href={resolve('/groups')}
			class="text-base-500 dark:text-base-400 mb-6 inline-block text-sm hover:underline"
			>← All groups</a
		>
		<h1 class="text-3xl font-bold sm:text-4xl">{data.groupName}</h1>
		<GroupSignInNotice groupDid={data.group.group_did} subject="group" class="mt-6" />
	</div>
{:else if data.setupUnfinished}
	<!-- Only its creator sees this: the group host made the group, setting it up here stopped. -->
	<div class="mx-auto max-w-3xl px-6 py-8 sm:py-12">
		<a
			href={resolve('/groups')}
			class="text-base-500 dark:text-base-400 mb-6 inline-block text-sm hover:underline"
			>← All groups</a
		>
		<h1 class="text-3xl font-bold sm:text-4xl">{data.groupName}</h1>
		<GroupSetupNotice groupDid={data.group.group_did} error={data.error} class="mt-6" />
	</div>
{:else}
	<GroupPage {data} />
{/if}
