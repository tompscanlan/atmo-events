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
	<!-- A group hidden from the caller until a new sign-in, such as a private
	     group's creator right after the create: nothing of it was read, so the
	     page holds the row's name and the notice. -->
	<div class="mx-auto max-w-3xl px-6 py-8 sm:py-12">
		<a
			href={resolve('/groups')}
			class="text-base-500 dark:text-base-400 mb-6 inline-block text-sm hover:underline"
			>← All groups</a
		>
		<h1 class="text-3xl font-bold sm:text-4xl">{data.groupName}</h1>
		<GroupSignInNotice
			groupDid={data.group.group_did}
			from={data.signIn.from}
			subject="group"
			class="mt-6"
		/>
	</div>
{:else}
	<GroupPage {data} />
{/if}
