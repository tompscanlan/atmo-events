<script lang="ts">
	import { AvatarGroup, Badge, Button, Input } from '@foxui/core';
	import { resolve } from '$app/paths';
	import { reauthorize } from '$lib/atproto/auth.svelte';
	import { groupFormError, resetOnSuccess } from '$lib/groups/form-result';
	import { joinGroupForm, leaveGroupForm } from '$lib/groups/roster.remote';
	import GroupDataSources from '$lib/groups/components/GroupDataSources.svelte';
	import GroupLinkForm from '$lib/groups/components/GroupLinkForm.svelte';
	import GroupMonogram from '$lib/groups/components/GroupMonogram.svelte';
	import GroupSettings from '$lib/groups/components/GroupSettings.svelte';
	import JoinRequestItem from '$lib/groups/components/JoinRequestItem.svelte';
	import PdslsLink from '$lib/groups/components/PdslsLink.svelte';
	import PersonLabel from '$lib/groups/components/PersonLabel.svelte';

	let { data } = $props();

	let group = $derived(data.group);
	// Name, description, location and rules come from the about-space records,
	// with the cache as fallback; `data.about.source` says which.
	let about = $derived(data.about);
	let membership = $derived(data.membership);
	let isOwner = $derived(membership.role === 'owner');
	let isMember = $derived(membership.role !== null);
	let isPending = $derived(membership.pendingRequestId !== null);
	// What the group published, not what our columns imply. `joinPolicy` is the
	// profile record's own field for a public group, and invite-only for any
	// other: the loader derives it from the host's visibility (`groupFace`), and
	// from `require_approval` only when there is no record to read. Reading the
	// columns here would let the page contradict the group's host.
	let joinPolicy = $derived(about.joinPolicy);
	let joiningLabel = $derived(
		joinPolicy === 'open'
			? 'open to anyone'
			: joinPolicy === 'approval'
				? 'by approval'
				: 'invite only'
	);
	// The server still decides: a private group refuses a self-service join,
	// and the refusal comes back as the form error below. The label only
	// describes what pressing the button asks for.
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
	// A join or request comes back with an authorize URL when the member's session
	// should pick up this group's grant. The join already stands either way.
	$effect(() => {
		const result = joinGroupForm.result;
		if (result?.ok === true && result.reauthorize) reauthorize(result.reauthorize);
	});
	let leaveError = $derived(groupFormError(leaveGroupForm.result));
	// The group's visibility as its host reports it: the about space's read
	// policy. Null when the host could not be asked, and then no badge shows.
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
			<!-- The group's address, shown as the handle when its PDS confirms one.
			     A person can read, say and type a handle, so it belongs on the page.
			     The app does not link with it, because a handle can lapse and be
			     registered by another account, while the DID never moves. So the
			     text and the URL differ on purpose: the readable name here, the
			     permanent key in every href. -->
			<PdslsLink
				to={group.group_did}
				title="The group's account on pds.ls"
				class="text-base-500 dark:text-base-400 mt-1 inline-block font-mono text-sm break-all hover:underline"
				>{data.handle ? `@${data.handle}` : group.group_did}</PdslsLink
			>
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
		{#if about.locationName}
			<div class="ring-base-200 dark:ring-base-800 rounded-2xl p-4 ring-1">
				<p class="text-base-500 dark:text-base-400 text-xs font-medium uppercase">Where</p>
				<p class="mt-1 font-semibold">{about.locationName}</p>
			</div>
		{/if}
	</div>

	{#if data.ownerDid}
		<div class="mt-4 flex items-center gap-3 text-sm">
			<span class="text-base-500 dark:text-base-400">Organized by</span>
			<PersonLabel did={data.ownerDid} person={data.people[data.ownerDid]} size="sm" />
		</div>
	{/if}

	<div class="mt-8 flex flex-wrap items-center gap-3">
		<!-- The link carries the group's DID, so a page reached through a handle
		     URL still hands out DID links. -->
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
			{#if isOwner}
				<span class="text-base-500 dark:text-base-400 text-sm"
					>You own this group and cannot leave it.</span
				>
			{:else}
				<form {...resetOnSuccess(leaveGroupForm)}>
					<input type="hidden" name="groupDid" value={group.group_did} />
					<Button type="submit" variant="ghost">Leave group</Button>
				</form>
			{/if}
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

	{#if about.rules.length > 0}
		<section class="ring-base-200 dark:ring-base-800 mt-10 rounded-2xl p-5 ring-1">
			<h2 class="text-lg font-semibold">Group rules</h2>
			<!-- One record per rule, so each has a URI a moderation action can
			     cite. Rendered in the records' own `order`. -->
			<ol class="text-base-700 dark:text-base-200 mt-3 list-decimal space-y-2 pl-6 text-sm">
				{#each about.rules as rule (rule.uri)}
					<li>{rule.text}</li>
				{/each}
			</ol>
		</section>
	{/if}

	{#if data.canAdmitMembers && data.pendingRequests.length > 0}
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

	<GroupDataSources {group} source={about.source} rules={about.rules} />

	<!-- Outside the settings toggle: until the owner links, every write as the
	     group fails, so the one step that fixes it is not left folded away. -->
	{#if data.groupLinked === false}
		<GroupLinkForm
			groupDid={group.group_did}
			class="mt-10 rounded-2xl p-4 text-sm ring-1 ring-amber-500/40"
		>
			<p class="font-semibold">Link this group's account</p>
			<p class="mt-1">
				This site cannot write as the group until you do, so its events, settings and member changes
				wait on it. At the group's PDS you sign in as the group, not as yourself, with the email and
				password you chose when you created it, and approve this site.
			</p>
			<div class="mt-3"><Button type="submit">Link the group's account</Button></div>
		</GroupLinkForm>
	{/if}

	{#if data.canManageGroup}
		<GroupSettings
			{group}
			{about}
			{visibility}
			groupLinked={data.groupLinked}
			linkOutcome={data.linkOutcome}
		/>
	{/if}
</div>
