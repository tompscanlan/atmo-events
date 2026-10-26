<script lang="ts">
	import { AvatarGroup, Badge, Button, Input } from '@foxui/core';
	import { resolve } from '$app/paths';
	import { groupFormError, resetOnSuccess } from '$lib/groups/form-result';
	import { joinGroupForm, leaveGroupForm } from '$lib/groups/roster.remote';
	import GroupLinkForm from '$lib/groups/components/GroupLinkForm.svelte';
	import GroupMonogram from '$lib/groups/components/GroupMonogram.svelte';
	import GroupSettings from '$lib/groups/components/GroupSettings.svelte';
	import GroupSignInNotice from '$lib/groups/components/GroupSignInNotice.svelte';
	import JoinRequestItem from '$lib/groups/components/JoinRequestItem.svelte';
	import type { PageData } from './$types';

	let { data }: { data: Extract<PageData, { signInOnly: false }> } = $props();

	let group = $derived(data.group);
	let about = $derived(data.about);
	let membership = $derived(data.membership);
	let isMember = $derived(membership.role !== null);
	let isPending = $derived(membership.pendingRequestId !== null);
	let joinPolicy = $derived(about.joinPolicy);
	let joiningLabel = $derived(
		joinPolicy === 'open'
			? 'open to anyone'
			: joinPolicy === 'approval'
				? 'by approval'
				: 'invite only'
	);
	let joinLabel = $derived(
		joinPolicy === 'open'
			? 'Join'
			: joinPolicy === 'approval'
				? 'Request to join'
				: 'Ask to be invited'
	);
	let joinError = $derived(groupFormError(joinGroupForm.result));
	let joinPending = $derived(
		joinGroupForm.result?.ok === true && joinGroupForm.result.outcome === 'pending'
	);
	let leaveError = $derived(groupFormError(leaveGroupForm.result));
	// Null when the host could not be asked, and then no badge shows.
	let visibility = $derived(data.visibility);
</script>

<svelte:head>
	<title>{about.name} - atmo.rsvp</title>
	<meta name="description" content={about.description ?? `${about.name} on atmo.rsvp`} />
</svelte:head>

<div class="mx-auto max-w-3xl px-6 py-8 sm:py-12">
	<a
		href={resolve('/groups')}
		class="text-base-500 dark:text-base-400 mb-6 inline-block text-sm hover:underline"
		>← All groups</a
	>

	<header class="flex items-start gap-4">
		<GroupMonogram name={about.name} class="size-16 text-2xl" />
		<div class="min-w-0 flex-1">
			<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
				<h1 class="text-3xl font-bold sm:text-4xl">{about.name}</h1>
				{#if visibility}<Badge variant="secondary">{visibility}</Badge>{/if}
				{#if membership.role}<Badge>{membership.role}</Badge>{/if}
			</div>
			<!-- The handle to read; every href keys on the DID, which never moves. -->
			<p class="text-base-500 dark:text-base-400 mt-1 font-mono text-sm break-all">
				{data.handle ? `@${data.handle}` : group.group_did}
			</p>
		</div>
	</header>

	{#if about.description}
		<p class="text-base-700 dark:text-base-200 mt-6 whitespace-pre-line">{about.description}</p>
	{/if}

	<div class="mt-6 grid gap-3 sm:grid-cols-3">
		<div class="ring-base-200 dark:ring-base-800 rounded-2xl p-4 ring-1">
			<p class="text-base-500 dark:text-base-400 text-xs font-medium uppercase">Members</p>
			<p class="mt-1 text-2xl font-semibold">{data.memberCount}</p>
			{#if data.rosterPreview.length > 0}
				<a
					href={resolve('/(app)/groups/[actor]/members', { actor: group.group_did })}
					class="mt-2 inline-block"
					title="See every member"
				>
					<AvatarGroup
						users={data.rosterPreview.map((entry) => ({
							src: data.people[entry.did]?.avatar ?? undefined,
							alt: data.people[entry.did]?.handle ?? entry.did
						}))}
						avatarClass="size-7"
					/>
				</a>
			{/if}
		</div>
		<div class="ring-base-200 dark:ring-base-800 rounded-2xl p-4 ring-1">
			<p class="text-base-500 dark:text-base-400 text-xs font-medium uppercase">Joining</p>
			<p class="mt-1 font-semibold">{joiningLabel}</p>
		</div>
	</div>

	<div class="mt-8 flex flex-wrap items-center gap-3">
		<Button
			href={resolve('/(app)/groups/[actor]/events', { actor: group.group_did })}
			variant="secondary">Events</Button
		>
		{#if data.canSeeMembers}
			<Button
				href={resolve('/(app)/groups/[actor]/members', { actor: group.group_did })}
				variant="secondary">Members</Button
			>
		{/if}

		{#if !data.membership.did}
			<a href={resolve('/login')} class="text-accent-600 dark:text-accent-400 text-sm underline"
				>Sign in to join</a
			>
		{:else if isPending}
			<form {...resetOnSuccess(leaveGroupForm)}>
				<input type="hidden" name="groupDid" value={group.group_did} />
				<Button type="submit" variant="ghost">Withdraw request</Button>
			</form>
			<span class="text-base-500 dark:text-base-400 text-sm">Request pending approval</span>
		{:else if isMember}
			<form {...resetOnSuccess(leaveGroupForm)}>
				<input type="hidden" name="groupDid" value={group.group_did} />
				<Button type="submit" variant="ghost">Leave group</Button>
			</form>
		{:else}
			<form {...resetOnSuccess(joinGroupForm)} class="flex items-center gap-2">
				<input type="hidden" name="groupDid" value={group.group_did} />
				<Input name="message" placeholder="Say hello (optional)" class="w-56" />
				<Button type="submit">{joinLabel}</Button>
			</form>
		{/if}
	</div>

	{#if joinError}
		<p class="mt-3 text-sm text-red-600 dark:text-red-400">{joinError}</p>
	{:else if joinPending}
		<p class="text-base-500 dark:text-base-400 mt-3 text-sm">
			Request sent. An admin has to approve it.
		</p>
	{/if}
	{#if leaveError}
		<p class="mt-3 text-sm text-red-600 dark:text-red-400">{leaveError}</p>
	{/if}

	{#if membership.signIn}
		<GroupSignInNotice groupDid={group.group_did} class="mt-6" />
	{:else if data.confirmPrompt}
		<GroupSignInNotice groupDid={group.group_did} subject="confirm" class="mt-6" />
	{/if}

	<!-- Nothing could be read with the caller's own access: the row's name, no rules. -->
	{#if data.hiddenDetails === 'signed-out'}
		<p class="text-base-500 dark:text-base-400 mt-6 text-sm">
			Some details, like the group's rules, are hidden until you
			<a href={resolve('/login')} class="text-accent-600 dark:text-accent-400 underline">sign in</a
			>.
		</p>
	{:else if data.hiddenDetails === 'no-access'}
		<p class="text-base-500 dark:text-base-400 mt-6 text-sm">
			Some details, like the group's rules, can't be shown: your sign-in doesn't let this site read
			the group's spaces. Signing in again may fix it.
		</p>
	{/if}

	{#if about.rules.length > 0}
		<section class="ring-base-200 dark:ring-base-800 mt-10 rounded-2xl p-5 ring-1">
			<h2 class="text-lg font-semibold">Group rules</h2>
			<ol class="text-base-700 dark:text-base-200 mt-3 list-decimal space-y-2 pl-6 text-sm">
				{#each about.rules as rule (rule.uri)}
					<li>{rule.text}</li>
				{/each}
			</ol>
		</section>
	{/if}

	{#if data.canAdmitMembers && data.requestsNeedLink}
		<section class="mt-10">
			<h2 class="mb-3 text-xl font-semibold">Join requests</h2>
			<p class="text-base-500 dark:text-base-400 text-sm">
				Link your access to this group to see its join requests.
			</p>
		</section>
	{:else if data.canAdmitMembers && data.pendingRequests.length > 0}
		<section class="mt-10">
			<h2 class="mb-3 text-xl font-semibold">
				Join requests ({data.pendingRequests.length})
			</h2>
			<ul class="flex flex-col gap-2">
				{#each data.pendingRequests as request (request.id)}
					<JoinRequestItem groupDid={group.group_did} {request} person={data.people[request.did]} />
				{/each}
			</ul>
		</section>
	{/if}

	<!-- Outside the settings toggle: until this person links, every write as the group fails. -->
	{#if data.groupLinked === false}
		<GroupLinkForm
			groupDid={group.group_did}
			class="mt-10 rounded-2xl p-4 text-sm ring-1 ring-amber-500/40"
		>
			<p class="font-semibold">Link your access to this group</p>
			<p class="mt-1">
				This site writes as the group for you only through a session you approve, so your event,
				settings and member changes wait on it. At the group's host you sign in with your own
				account, and approve this site. The host lets it act for the group only as far as your roles
				in the group allow.
			</p>
			<div class="mt-3"><Button type="submit">Link your access</Button></div>
		</GroupLinkForm>
	{/if}

	{#if data.canManageGroup}
		<GroupSettings
			groupDid={group.group_did}
			{about}
			{visibility}
			listed={data.listed}
			groupLinked={data.groupLinked}
			linkOutcome={data.linkOutcome}
		/>
	{/if}
</div>
