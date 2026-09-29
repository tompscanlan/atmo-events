<script lang="ts">
	import { Badge, Button, Input, Label } from '@foxui/core';
	import {
		addMemberForm,
		approveJoinRequestForm,
		changeMemberRoleForm,
		rejectJoinRequestForm,
		removeMemberForm,
		suggestPeople
	} from '$lib/groups/groups.remote';
	import { groupFormError } from '$lib/groups/form-result';
	import { resetOnSuccess } from '$lib/groups/form-enhance';
	import PdslsLink from '$lib/groups/components/PdslsLink.svelte';
	import PersonLabel from '$lib/groups/components/PersonLabel.svelte';
	import type { Person } from '$lib/groups/types';
	import { resolve } from '$app/paths';

	let { data } = $props();

	let group = $derived(data.group);
	// The record's name, as on the group page and the events tab. The loader
	// uses the cache column only when there is no profile.
	let groupName = $derived(data.groupName);
	// Any of the three shows the controls column; each control asks its own.
	let canManageAnyMember = $derived(
		data.canAdmitMembers || data.canEjectMembers || data.canAssignRoles
	);
	// A remote form object attaches to one `<form>` only, so each row's forms
	// are their own instances (`.for(key)`), and each row shows its own result.
	let addError = $derived(groupFormError(addMemberForm.result));

	// Handle suggestions for the add form, from this site's own index of
	// accounts (`suggestPeople`), so no outside service sees what is typed. A
	// suggestion only fills the field; the server resolves whatever is submitted.
	let suggestions = $state<Person[]>([]);
	let lastQuery = '';
	let typeaheadTimer: ReturnType<typeof setTimeout> | undefined;
	function suggest(input: string) {
		clearTimeout(typeaheadTimer);
		const query = input.trim().replace(/^@/, '');
		lastQuery = query;
		if (query.length < 2 || query.startsWith('did:')) {
			suggestions = [];
			return;
		}
		typeaheadTimer = setTimeout(async () => {
			const found = await suggestPeople(query).catch(() => []);
			// A slower answer to an older query must not replace a newer one.
			if (query === lastQuery) suggestions = found;
		}, 200);
	}
</script>

<svelte:head><title>{groupName} members - atmo.rsvp</title></svelte:head>

<div class="mx-auto max-w-3xl px-6 py-8 sm:py-12">
	<!-- Back to the group by DID: every link this app publishes uses the DID,
	     because a handle is a name someone else can end up holding. -->
	<a
		href={resolve('/(app)/groups/[actor]', { actor: group.group_did })}
		class="text-base-500 dark:text-base-400 mb-4 inline-block text-sm hover:underline"
		>← {groupName}</a
	>

	<h1 class="text-3xl font-bold">Members</h1>
	<!-- Says where the roster came from, as the group page does for its profile. -->
	<p class="text-base-500 dark:text-base-400 mt-1 mb-6 text-sm">
		{#if data.rosterSource === 'records' && group.members_space_uri}
			Read from the membership records in this group's
			<PdslsLink to={group.members_space_uri} class="underline">members space</PdslsLink>.
		{:else}
			Reading from cache. This group's members space holds no membership records yet.
		{/if}
	</p>

	{#if addError}
		<p class="mb-6 text-sm text-red-600 dark:text-red-400">{addError}</p>
	{/if}

	<ul class="flex flex-col gap-2">
		{#each data.members as member (member.did)}
			<li class="ring-base-200 dark:ring-base-800 rounded-xl p-3 ring-1">
				<div class="flex flex-wrap items-center justify-between gap-3">
					<div class="flex min-w-0 items-center gap-3">
						<PersonLabel did={member.did} person={data.people[member.did]} />
						<Badge variant={member.role === 'owner' ? 'primary' : 'secondary'}>
							{member.role}
						</Badge>
						{#if member.recordUri}
							<!-- The membership record itself, in the members space. -->
							<PdslsLink
								to={member.recordUri}
								title="This membership record on pds.ls"
								class="text-base-400 dark:text-base-500 shrink-0 text-xs hover:underline"
								>record ↗</PdslsLink
							>
						{/if}
					</div>

					{#if canManageAnyMember && member.role !== 'owner'}
						{@const roleForm = changeMemberRoleForm.for(member.did)}
						{@const removeForm = removeMemberForm.for(member.did)}
						{@const rowError = groupFormError(roleForm.result) ?? groupFormError(removeForm.result)}
						<div class="flex shrink-0 flex-wrap items-center gap-2">
							{#if data.canAssignRoles}
								<form {...resetOnSuccess(roleForm)} class="flex items-center gap-1">
									<input type="hidden" name="groupDid" value={group.group_did} />
									<input type="hidden" name="did" value={member.did} />
									<select
										name="role"
										class="ring-base-200 dark:ring-base-800 bg-base-100/50 dark:bg-base-900/50 rounded-ui border-0 px-2 py-1 text-xs ring-1 ring-inset"
									>
										{#each data.assignableRoles as role (role)}
											<option value={role} selected={member.role === role}>{role}</option>
										{/each}
									</select>
									<Button type="submit" size="sm" variant="secondary">Set role</Button>
								</form>
							{/if}
							{#if data.canEjectMembers}
								<form {...resetOnSuccess(removeForm)}>
									<input type="hidden" name="groupDid" value={group.group_did} />
									<input type="hidden" name="did" value={member.did} />
									<button
										type="submit"
										class="text-xs text-red-600 hover:underline dark:text-red-400">Remove</button
									>
								</form>
							{/if}
						</div>
						{#if rowError}
							<p class="w-full text-sm text-red-600 dark:text-red-400">{rowError}</p>
						{/if}
					{:else if member.role === 'owner'}
						<span class="text-base-400 dark:text-base-500 shrink-0 text-xs"
							>owner, cannot be changed</span
						>
					{/if}
				</div>
			</li>
		{/each}
	</ul>

	{#if data.canAdmitMembers}
		<section class="mt-10">
			<h2 class="mb-3 text-xl font-semibold">Pending requests</h2>
			{#if data.pendingRequests.length === 0}
				<p class="text-base-500 dark:text-base-400 text-sm">None.</p>
			{:else}
				<ul class="flex flex-col gap-2">
					{#each data.pendingRequests as request (request.id)}
						{@const approveForm = approveJoinRequestForm.for(request.id)}
						{@const rejectForm = rejectJoinRequestForm.for(request.id)}
						{@const requestError =
							groupFormError(approveForm.result) ?? groupFormError(rejectForm.result)}
						<li
							class="ring-base-200 dark:ring-base-800 flex flex-wrap items-center justify-between gap-3 rounded-xl p-3 ring-1"
						>
							<div class="min-w-0">
								<PersonLabel did={request.did} person={data.people[request.did]} />
								{#if request.message}
									<p class="text-base-500 dark:text-base-400 mt-2 text-sm">{request.message}</p>
								{/if}
							</div>
							<div class="flex shrink-0 items-center gap-2">
								<form {...resetOnSuccess(approveForm)} class="flex items-center gap-1">
									<input type="hidden" name="groupDid" value={group.group_did} />
									<input type="hidden" name="requestId" value={request.id} />
									<select
										name="role"
										class="ring-base-200 dark:ring-base-800 bg-base-100/50 dark:bg-base-900/50 rounded-ui border-0 px-2 py-1 text-xs ring-1 ring-inset"
									>
										{#each data.assignableRoles as role (role)}
											<option value={role} selected={role === 'member'}>{role}</option>
										{/each}
									</select>
									<Button type="submit" size="sm">Approve</Button>
								</form>
								<form {...resetOnSuccess(rejectForm)}>
									<input type="hidden" name="groupDid" value={group.group_did} />
									<input type="hidden" name="requestId" value={request.id} />
									<Button type="submit" size="sm" variant="ghost">Reject</Button>
								</form>
							</div>
							{#if requestError}
								<p class="w-full text-sm text-red-600 dark:text-red-400">{requestError}</p>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}

			<h2 class="mt-8 mb-1 text-xl font-semibold">Add a member directly</h2>
			<p class="text-base-500 dark:text-base-400 mb-3 text-sm">
				They join at once, with the role you pick. No request or acceptance is involved.
			</p>
			<form {...resetOnSuccess(addMemberForm)} class="flex flex-wrap items-end gap-2">
				<input type="hidden" name="groupDid" value={group.group_did} />
				<div class="flex flex-col gap-1.5">
					<Label for="add-actor">Handle or DID</Label>
					<Input
						id="add-actor"
						name="actor"
						placeholder="alice.bsky.social"
						autocomplete="off"
						list="add-actor-suggestions"
						oninput={(e: Event) => suggest((e.currentTarget as HTMLInputElement).value)}
						required
						class="w-72"
					/>
					<datalist id="add-actor-suggestions">
						{#each suggestions as suggestion (suggestion.did)}
							<option value={suggestion.handle ?? suggestion.did}
								>{suggestion.displayName ?? ''}</option
							>
						{/each}
					</datalist>
				</div>
				<div class="flex flex-col gap-1.5">
					<Label for="add-role">Role</Label>
					<select
						id="add-role"
						name="role"
						class="ring-base-200 dark:ring-base-800 bg-base-100/50 dark:bg-base-900/50 rounded-ui border-0 px-3 py-1.5 text-sm ring-1 ring-inset"
					>
						{#each data.assignableRoles as role (role)}
							<option value={role} selected={role === 'member'}>{role}</option>
						{/each}
					</select>
				</div>
				<Button type="submit">Add</Button>
			</form>
		</section>
	{/if}

	{#if canManageAnyMember}
		<section class="mt-10">
			<h2 class="mb-3 text-xl font-semibold">What each role grants</h2>
			<p class="text-base-500 dark:text-base-400 mb-3 text-sm">
				Permissions are stored per group, and every name here is enforced.
			</p>
			<div class="flex flex-col gap-3">
				{#each Object.entries(data.rolePermissions) as [role, permissions] (role)}
					<div class="ring-base-200 dark:ring-base-800 rounded-xl p-3 ring-1">
						<p class="mb-2 font-semibold">{role}</p>
						<div class="flex flex-wrap gap-1.5">
							{#each permissions as permission (permission)}
								<span
									class="bg-accent-400/10 text-accent-700 dark:text-accent-400 rounded-full px-2 py-0.5 font-mono text-xs"
								>
									{permission}
								</span>
							{:else}
								<span class="text-base-500 dark:text-base-400 text-xs"
									>nothing. Membership itself is what this role holds.</span
								>
							{/each}
						</div>
					</div>
				{/each}
			</div>
		</section>
	{/if}
</div>
