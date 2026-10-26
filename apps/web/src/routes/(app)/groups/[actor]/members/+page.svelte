<script lang="ts">
	import { Badge, Button, Input, Label } from '@foxui/core';

	import { groupFormError, resetOnSuccess } from '$lib/groups/form-result';

	import PersonLabel from '$lib/groups/components/PersonLabel.svelte';
	import { resolve } from '$app/paths';
	import { addMemberForm, changeMemberRoleForm, removeMemberForm } from '$lib/groups/roster.remote';
	import JoinRequestItem from '$lib/groups/components/JoinRequestItem.svelte';
	import GroupSignInNotice from '$lib/groups/components/GroupSignInNotice.svelte';
	import type { RosterEntry } from '$lib/groups/types';

	let { data } = $props();

	let group = $derived(data.group);
	let groupName = $derived(data.groupName);
	let canManageAnyMember = $derived(
		data.canAdmitMembers || data.canEjectMembers || data.canAssignRoles
	);
	// A remote form attaches to one `<form>` only, so each row's forms are `.for(key)`.
	let addError = $derived(groupFormError(addMemberForm.result));
</script>

{#snippet memberRow(member: RosterEntry)}
	<li class="ring-base-200 dark:ring-base-800 rounded-xl p-3 ring-1">
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div class="flex min-w-0 items-center gap-3">
				<PersonLabel did={member.did} person={data.people?.[member.did]} />
				<Badge variant={member.role === 'admin' ? 'primary' : 'secondary'}>
					{member.role}
				</Badge>
			</div>

			{#if canManageAnyMember}
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
							<button type="submit" class="text-xs text-red-600 hover:underline dark:text-red-400"
								>Remove</button
							>
						</form>
					{/if}
				</div>
				{#if rowError}
					<p class="w-full text-sm text-red-600 dark:text-red-400">{rowError}</p>
				{/if}
			{/if}
		</div>
	</li>
{/snippet}

<svelte:head><title>{groupName} members - atmo.rsvp</title></svelte:head>

<div class="mx-auto max-w-3xl px-6 py-8 sm:py-12">
	<a
		href={resolve('/(app)/groups/[actor]', { actor: group.group_did })}
		class="text-base-500 dark:text-base-400 mb-4 inline-block text-sm hover:underline"
		>← {groupName}</a
	>

	<h1 class="text-3xl font-bold">Members</h1>
	{#if data.signIn}
		<GroupSignInNotice groupDid={group.group_did} class="mt-4" />
	{:else}
		{#if data.confirmPrompt}
			<GroupSignInNotice groupDid={group.group_did} subject="confirm" class="mt-4" />
		{/if}
		{#if addError}
			<p class="mt-6 text-sm text-red-600 dark:text-red-400">{addError}</p>
		{/if}

		<ul class="mt-6 flex flex-col gap-2">
			{#each data.members as member (member.did)}
				{@render memberRow(member)}
			{/each}
		</ul>

		{#if data.unconfirmed.length > 0}
			<section class="mt-10">
				<h2 class="mb-1 text-xl font-semibold">Added, not yet confirmed</h2>
				<p class="text-base-500 dark:text-base-400 mb-3 text-sm">
					They hold a membership, so they have access, but they have not confirmed it from their own
					account, so the roster others see leaves them out. A PDS without spaces cannot confirm.
				</p>
				<ul class="flex flex-col gap-2">
					{#each data.unconfirmed as member (member.did)}
						{@render memberRow(member)}
					{/each}
				</ul>
			</section>
		{/if}

		<!-- Rows the records no longer back; each Remove shares its roster row's form. -->
		{#if data.unfinished.length > 0}
			<section class="mt-10">
				<h2 class="mb-1 text-xl font-semibold">Not finished</h2>
				<p class="text-base-500 dark:text-base-400 mb-3 text-sm">
					These people have no membership record, so they have no access here, but a removal or an
					addition stopped partway. Remove finishes it. To keep someone, remove them, then add them
					again.
				</p>
				<ul class="flex flex-col gap-2">
					{#each data.unfinished as did (did)}
						{@const removeForm = removeMemberForm.for(did)}
						{@const rowError = groupFormError(removeForm.result)}
						<li class="ring-base-200 dark:ring-base-800 rounded-xl p-3 ring-1">
							<div class="flex flex-wrap items-center justify-between gap-3">
								<PersonLabel {did} person={data.people[did]} />
								<form {...resetOnSuccess(removeForm)}>
									<input type="hidden" name="groupDid" value={group.group_did} />
									<input type="hidden" name="did" value={did} />
									<button
										type="submit"
										class="text-xs text-red-600 hover:underline dark:text-red-400">Remove</button
									>
								</form>
								{#if rowError}
									<p class="w-full text-sm text-red-600 dark:text-red-400">{rowError}</p>
								{/if}
							</div>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		{#if data.canAdmitMembers}
			<section class="mt-10">
				<h2 class="mb-3 text-xl font-semibold">Pending requests</h2>
				{#if data.requestsNeedLink}
					<p class="text-base-500 dark:text-base-400 text-sm">
						Link your access to this group, from the group page, to see its join requests.
					</p>
				{:else if data.pendingRequests.length === 0}
					<p class="text-base-500 dark:text-base-400 text-sm">None.</p>
				{:else}
					<ul class="flex flex-col gap-2">
						{#each data.pendingRequests as request (request.id)}
							<JoinRequestItem
								groupDid={group.group_did}
								{request}
								person={data.people[request.did]}
								roles={data.assignableRoles}
							/>
						{/each}
					</ul>
				{/if}

				<h2 class="mt-8 mb-1 text-xl font-semibold">Add a member directly</h2>
				<p class="text-base-500 dark:text-base-400 mb-3 text-sm">
					They join at once, with the role you pick, and show as not yet confirmed until they next
					sign in or visit.
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
							required
							class="w-72"
						/>
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
					From the group's own role records.
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
	{/if}
</div>
