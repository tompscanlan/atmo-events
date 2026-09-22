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
	import { resolve } from '$app/paths';

	let { data } = $props();

	let group = $derived(data.group);
	// Name/description/location/rules come from the about-space records, with
	// the cache as fallback; `data.about.source` says which. (Spec: FR-004.)
	let about = $derived(data.about);
	let membership = $derived(data.membership);
	let isOwner = $derived(membership.role === 'owner');
	let isMember = $derived(membership.role !== null);
	let isPending = $derived(membership.pendingRequestId !== null);
	// WHAT THE GROUP PUBLISHED, not what our columns imply. `joinPolicy` is the
	// profile record's own field; the loader only falls back to deriving it from
	// `visibility`/`require_approval` when there is no record to read (FR-004b).
	// Reading the columns here would let the page contradict the record a
	// stranger fetches from the group's PDS.
	let joinPolicy = $derived(about.joinPolicy);
	let joiningLabel = $derived(
		joinPolicy === 'open'
			? 'open to anyone'
			: joinPolicy === 'approval'
				? 'by approval'
				: 'invite only'
	);
	// The server still adjudicates: a private group refuses a self-service join
	// outright, and the refusal comes back as the form error below. The label
	// only has to describe what pressing the button asks for.
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
	let settingsError = $derived(groupFormError(updateGroupForm.result));
	let showSettings = $state(false);
</script>

<svelte:head>
	<title>{about.name} — atmo.rsvp</title>
	<meta name="description" content={about.description ?? `${about.name} on atmo.rsvp`} />
</svelte:head>

<div class="mx-auto max-w-3xl px-6 py-8 sm:py-12">
	<a
		href="/groups"
		class="text-base-500 dark:text-base-400 mb-4 inline-block text-sm hover:underline"
		>← All groups</a
	>

	<div class="flex flex-wrap items-start justify-between gap-4">
		<div class="min-w-0">
			<h1 class="text-3xl font-bold sm:text-4xl">{about.name}</h1>
			<!-- THE GROUP'S ADDRESS, shown as the handle when its PDS confirms one.
			     A handle is the half a person can read, say and type, so it is what
			     belongs on the page; it is NOT what the app links with, because a
			     handle can lapse and be re-registered by another account while the
			     DID never moves. Text and URL therefore disagree on purpose: the
			     readable name here, the permanent key in every href. (FR-010a.) -->
			<p class="text-base-400 dark:text-base-500 mt-2 font-mono text-xs break-all">
				{data.handle ?? group.group_did}
			</p>
		</div>
		<div class="flex shrink-0 flex-wrap gap-2">
			<Badge variant="secondary">{group.visibility}</Badge>
			{#if membership.role}<Badge>{membership.role}</Badge>{/if}
		</div>
	</div>

	{#if about.description}
		<p class="text-base-700 dark:text-base-200 mt-4 whitespace-pre-line">{about.description}</p>
	{/if}

	<dl class="text-base-500 dark:text-base-400 mt-6 flex flex-wrap gap-x-6 gap-y-1 text-sm">
		<div>
			<dt class="inline">Members:</dt>
			<dd class="inline">{data.memberCount}</dd>
		</div>
		{#if about.locationName}
			<div>
				<dt class="inline">Where:</dt>
				<dd class="inline">{about.locationName}</dd>
			</div>
		{/if}
		<div>
			<dt class="inline">Joining:</dt>
			<dd class="inline">{joiningLabel}</dd>
		</div>
		{#if group.about_space_uri}
			<div class="w-full">
				<dt class="inline">About space:</dt>
				<dd class="inline font-mono text-xs break-all">{group.about_space_uri}</dd>
			</div>
		{/if}
		{#if group.members_space_uri}
			<div class="w-full">
				<dt class="inline">Members space:</dt>
				<dd class="inline font-mono text-xs break-all">{group.members_space_uri}</dd>
			</div>
		{/if}
	</dl>

	{#if about.rules.length > 0}
		<section class="mt-6">
			<h2 class="text-lg font-semibold">Group rules</h2>
			<!-- One record per rule, so each carries the URI a moderation action
			     would cite. Rendered in the records' own `order`. (Spec: FR-004c.) -->
			<ol class="text-base-700 dark:text-base-200 mt-2 list-decimal space-y-1 pl-6 text-sm">
				{#each about.rules as rule (rule.uri)}
					<li>{rule.text}</li>
				{/each}
			</ol>
		</section>
	{/if}

	<!-- The provenance marker SC-002 is observed through: a page reading records
	     says so, and one falling back to the cache says that instead. A group
	     created before the profile writer existed is the second case. -->
	<p class="text-base-400 dark:text-base-500 mt-4 text-xs">
		{about.source === 'records'
			? 'Name, description and rules read from this group’s about space.'
			: 'Reading from cache — this group has no profile record yet.'}
	</p>

	<div class="mt-6 flex flex-wrap items-center gap-3">
		<!-- Both children key on the same DID this page was reached by, so a group
		     reached through a handle URL still hands out DID links. -->
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
			<a href="/login" class="text-accent-600 dark:text-accent-400 text-sm underline"
				>Sign in to join</a
			>
		{:else if isPending}
			<form {...leaveGroupForm}>
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
				<form {...leaveGroupForm}>
					<input type="hidden" name="groupDid" value={group.group_did} />
					<Button type="submit" variant="ghost">Leave group</Button>
				</form>
			{/if}
		{:else}
			<form {...joinGroupForm} class="flex items-center gap-2">
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
			Request sent — an admin has to approve it.
		</p>
	{/if}
	{#if leaveError}
		<p class="mt-3 text-sm text-red-600 dark:text-red-400">{leaveError}</p>
	{/if}

	{#if data.canAdmitMembers && data.pendingRequests.length > 0}
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
								<input type="hidden" name="groupDid" value={group.group_did} />
								<input type="hidden" name="requestId" value={request.id} />
								<input type="hidden" name="role" value="member" />
								<Button type="submit" size="sm">Approve</Button>
							</form>
							<form {...rejectJoinRequestForm}>
								<input type="hidden" name="groupDid" value={group.group_did} />
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
					<input type="hidden" name="groupDid" value={group.group_did} />
					<div class="flex flex-col gap-1.5">
						<Label for="settings-name">Name</Label>
						<Input id="settings-name" name="name" value={about.name} required />
					</div>
					<div class="flex flex-col gap-1.5">
						<Label for="settings-description">Description</Label>
						<textarea
							id="settings-description"
							name="description"
							rows="3"
							class="ring-accent-500/30 dark:ring-accent-500/20 bg-accent-400/5 dark:bg-accent-600/5 text-accent-700 dark:text-accent-400 rounded-ui border-0 px-3 py-1.5 text-sm ring-1 ring-inset"
							>{about.description ?? ''}</textarea
						>
					</div>
					<div class="flex flex-col gap-1.5">
						<Label for="settings-rules">Rules</Label>
						<textarea
							id="settings-rules"
							name="rules"
							rows="4"
							placeholder="One rule per line"
							class="ring-accent-500/30 dark:ring-accent-500/20 bg-accent-400/5 dark:bg-accent-600/5 text-accent-700 dark:text-accent-400 rounded-ui border-0 px-3 py-1.5 text-sm ring-1 ring-inset"
							>{about.rules.map((rule) => rule.text).join('\n')}</textarea
						>
						<p class="text-base-500 dark:text-base-400 text-xs">
							One rule per line. Each line is its own record, so editing one rule leaves the others’
							addresses untouched.
						</p>
					</div>
					<div class="flex flex-col gap-1.5">
						<Label for="settings-visibility">Visibility</Label>
						<select
							id="settings-visibility"
							name="visibility"
							class="ring-accent-500/30 dark:ring-accent-500/20 bg-accent-400/5 dark:bg-accent-600/5 text-accent-700 dark:text-accent-400 rounded-ui border-0 px-3 py-1.5 text-sm ring-1 ring-inset"
						>
							{#each ['public', 'private'] as value (value)}
								<option {value} selected={group.visibility === value}>{value}</option>
							{/each}
						</select>
					</div>
					<!-- No Space URI field: both spaces are provisioned at create under the
					     group's own DID, so there is nothing here to edit. They are shown
					     read-only in the header above. -->
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
