<script lang="ts">
	import { resolve } from '$app/paths';
	import GroupSignInNotice from '$lib/groups/components/GroupSignInNotice.svelte';
	import GroupPage from './GroupPage.svelte';

	let { data } = $props();
</script>

<!-- GroupPage sets its own head. -->
<svelte:head>
	{#if data.signInOnly}<title>{data.groupName} - atmo.rsvp</title>{/if}
</svelte:head>

{#if data.signInOnly}
	<!-- Hidden until a new sign-in: nothing of the group was read, so only the row's name. -->
	<div class="mx-auto max-w-3xl px-6 py-8 sm:py-12">
		<a
			href={resolve('/groups')}
			class="text-base-500 dark:text-base-400 mb-6 inline-block text-sm hover:underline"
			>← All groups</a
		>
		<h1 class="text-3xl font-bold sm:text-4xl">{data.groupName}</h1>
		<GroupSignInNotice groupDid={data.group.group_did} subject="group" class="mt-6" />
	</div>
{:else}
	<GroupPage {data} />
{/if}
