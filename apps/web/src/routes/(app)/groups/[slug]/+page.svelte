<script lang="ts">
	import { Badge, Button, Input, Label } from '@foxui/core';
	import {
		approveJoinRequestForm,
		joinGroupForm,
		leaveGroupForm,
		rejectJoinRequestForm,
		updateGroupForm
	} from '$lib/groups/groups.remote';
	import { groupFormError } from '$lib/groups/form-result';

	let { data } = $props();

	let group = $derived(data.group);
	let membership = $derived(data.membership);
	let isOwner = $derived(membership.role === 'owner');
	let isMember = $derived(membership.role !== null);
	let isPending = $derived(membership.pendingRequestId !== null);
	let joinError = $derived(groupFormError(joinGroupForm.result));
	let joinPending = $derived(
		joinGroupForm.result?.ok === true && joinGroupForm.result.outcome === 'pending'
	);
	let leaveError = $derived(groupFormError(leaveGroupForm.result));
	let settingsError = $derived(groupFormError(updateGroupForm.result));
	let showSettings = $state(false);
</script>

<svelte:head>
	<title>{group.name} — atmo.rsvp</title>
	<meta name="description" content={group.description ?? `${group.name} on atmo.rsvp`} />
</svelte:head>

<div class="mx-auto max-w-3xl px-6 py-8 sm:py-12">
	<a
		href="/groups"
		class="text-base-500 dark:text-base-400 mb-4 inline-block text-sm hover:underline"
		>← All groups</a
	>

	<div class="flex flex-wrap items-start justify-between gap-4">
		<div class="min-w-0">
			<h1 class="text-3xl font-bold sm:text-4xl">{group.name}</h1>
			<p class="text-base-400 dark:text-base-500 mt-2 font-mono text-xs break-all">
				{group.group_did}
			</p>
		</div>
		<div class="flex shrink-0 flex-wrap gap-2">
			{#if group.status !== 'published'}<Badge variant="secondary">{group.status}</Badge>{/if}
			<Badge variant="secondary">{group.visibility}</Badge>
			{#if membership.role}<Badge>{membership.role}</Badge>{/if}
		</div>
	</div>

	{#if group.description}
		<p class="text-base-700 dark:text-base-200 mt-4 whitespace-pre-line">{group.description}</p>
	{/if}

	<dl class="text-base-500 dark:text-base-400 mt-6 flex flex-wrap gap-x-6 gap-y-1 text-sm">
		<div>
			<dt class="inline">Members:</dt>
			<dd class="inline">{data.memberCount}</dd>
		</div>
		{#if group.location_name}
			<div>
				<dt class="inline">Where:</dt>
				<dd class="inline">{group.location_name}</dd>
			</div>
		{/if}
		<div>
			<dt class="inline">Joining:</dt>
			<dd class="inline">{group.require_approval ? 'by approval' : 'open'}</dd>
		</div>
		{#if group.space_uri}
			<div class="w-full">
				<dt class="inline">Space:</dt>
				<dd class="inline font-mono text-xs break-all">{group.space_uri}</dd>
			</div>
		{/if}
	</dl>

	<div class="mt-6 flex flex-wrap items-center gap-3">
		<Button href="/groups/{group.slug}/events" variant="secondary">Events</Button>
		{#if data.canSeeMembers}
			<Button href="/groups/{group.slug}/members" variant="secondary">Members</Button>
		{/if}

		{#if !data.membership.did}
			<a href="/login" class="text-accent-600 dark:text-accent-400 text-sm underline"
				>Sign in to join</a
			>
		{:else if isPending}
			<form {...leaveGroupForm}>
				<input type="hidden" name="slug" value={group.slug} />
				<Button type="submit" variant="ghost">Withdraw request</Button>
			</form>
			<span class="text-base-500 dark:text-base-400 text-sm">Request pending approval</span>
		{:else if isMember}
			{#if isOwner}
				<span class="text-base-500 dark:text-base-400 text-sm"
					>You own this group and cannot leave it.</span
				>
			{:else}
				<form {...leaveGroupForm}>
					<input type="hidden" name="slug" value={group.slug} />
					<Button type="submit" variant="ghost">Leave group</Button>
				</form>
			{/if}
		{:else}
			<form {...joinGroupForm} class="flex items-center gap-2">
				<input type="hidden" name="slug" value={group.slug} />
				<Input name="message" placeholder="Say hello (optional)" class="w-56" />
				<Button type="submit">{group.require_approval ? 'Request to join' : 'Join'}</Button>
			</form>
		{/if}
	</div>

	{#if joinError}
		<p class="mt-3 text-sm text-red-600 dark:text-red-400">{joinError}</p>
	{:else if joinPending}
		<p class="text-base-500 dark:text-base-400 mt-3 text-sm">
			Request sent — an admin has to approve it.
		</p>
	{/if}
	{#if leaveError}
		<p class="mt-3 text-sm text-red-600 dark:text-red-400">{leaveError}</p>
	{/if}

	{#if data.canManageMembers && data.pendingRequests.length > 0}
		<section class="mt-10">
			<h2 class="mb-3 text-xl font-semibold">
				Join requests ({data.pendingRequests.length})
			</h2>
			<ul class="flex flex-col gap-2">
				{#each data.pendingRequests as request (request.id)}
					<li
						class="ring-base-200 dark:ring-base-800 flex flex-wrap items-center justify-between gap-3 rounded-xl p-3 ring-1"
					>
						<div class="min-w-0">
							<p class="font-mono text-xs break-all">{request.did}</p>
							{#if request.message}
								<p class="text-base-500 dark:text-base-400 mt-1 text-sm">{request.message}</p>
							{/if}
						</div>
						<div class="flex shrink-0 gap-2">
							<form {...approveJoinRequestForm}>
								<input type="hidden" name="slug" value={group.slug} />
								<input type="hidden" name="requestId" value={request.id} />
								<input type="hidden" name="role" value="member" />
								<Button type="submit" size="sm">Approve</Button>
							</form>
							<form {...rejectJoinRequestForm}>
								<input type="hidden" name="slug" value={group.slug} />
								<input type="hidden" name="requestId" value={request.id} />
								<Button type="submit" size="sm" variant="ghost">Reject</Button>
							</form>
						</div>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if data.canManageGroup}
		<section class="mt-10">
			<button
				type="button"
				class="text-base-500 dark:text-base-400 text-sm hover:underline"
				onclick={() => (showSettings = !showSettings)}
			>
				{showSettings ? 'Hide' : 'Show'} group settings
			</button>

			{#if showSettings}
				<form {...updateGroupForm} class="mt-4 flex flex-col gap-4">
					<input type="hidden" name="slug" value={group.slug} />
					<div class="flex flex-col gap-1.5">
						<Label for="settings-name">Name</Label>
						<Input id="settings-name" name="name" value={group.name} required />
					</div>
					<div class="flex flex-col gap-1.5">
						<Label for="settings-description">Description</Label>
						<textarea
							id="settings-description"
							name="description"
							rows="3"
							class="ring-accent-500/30 dark:ring-accent-500/20 bg-accent-400/5 dark:bg-accent-600/5 text-accent-700 dark:text-accent-400 rounded-ui border-0 px-3 py-1.5 text-sm ring-1 ring-inset"
							>{group.description ?? ''}</textarea
						>
					</div>
					<div class="grid gap-4 sm:grid-cols-2">
						<div class="flex flex-col gap-1.5">
							<Label for="settings-visibility">Visibility</Label>
							<select
								id="settings-visibility"
								name="visibility"
								class="ring-accent-500/30 dark:ring-accent-500/20 bg-accent-400/5 dark:bg-accent-600/5 text-accent-700 dark:text-accent-400 rounded-ui border-0 px-3 py-1.5 text-sm ring-1 ring-inset"
							>
								{#each ['public', 'unlisted', 'private'] as value (value)}
									<option {value} selected={group.visibility === value}>{value}</option>
								{/each}
							</select>
						</div>
						<div class="flex flex-col gap-1.5">
							<Label for="settings-status">Status</Label>
							<select
								id="settings-status"
								name="status"
								class="ring-accent-500/30 dark:ring-accent-500/20 bg-accent-400/5 dark:bg-accent-600/5 text-accent-700 dark:text-accent-400 rounded-ui border-0 px-3 py-1.5 text-sm ring-1 ring-inset"
							>
								{#each ['draft', 'pending', 'published'] as value (value)}
									<option {value} selected={group.status === value}>{value}</option>
								{/each}
							</select>
						</div>
					</div>
					<div class="flex flex-col gap-1.5">
						<Label for="settings-space">Space URI</Label>
						<Input
							id="settings-space"
							name="spaceUri"
							value={group.space_uri ?? ''}
							class="font-mono"
						/>
					</div>
					<label class="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							name="requireApproval"
							checked={!!group.require_approval}
							class="size-4"
						/>
						Require approval to join
					</label>
					{#if settingsError}
						<p class="text-sm text-red-600 dark:text-red-400">{settingsError}</p>
					{:else if updateGroupForm.result?.ok}
						<p class="text-base-500 dark:text-base-400 text-sm">Saved.</p>
					{/if}
					<div><Button type="submit">Save settings</Button></div>
				</form>
			{/if}
		</section>
	{/if}
</div>
