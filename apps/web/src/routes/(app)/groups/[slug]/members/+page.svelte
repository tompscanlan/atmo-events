<script lang="ts">
	import { Badge, Button, Input, Label } from '@foxui/core';
	import {
		addMemberForm,
		approveJoinRequestForm,
		changeMemberRoleForm,
		rejectJoinRequestForm,
		removeMemberForm,
		setMemberStatusForm
	} from '$lib/groups/groups.remote';
	import { groupFormError } from '$lib/groups/form-result';

	let { data } = $props();

	let group = $derived(data.group);
	let inert = $derived(new Set<string>(data.inertPermissions));
	let formError = $derived(
		groupFormError(changeMemberRoleForm.result) ??
			groupFormError(removeMemberForm.result) ??
			groupFormError(setMemberStatusForm.result) ??
			groupFormError(addMemberForm.result) ??
			groupFormError(approveJoinRequestForm.result) ??
			groupFormError(rejectJoinRequestForm.result)
	);
</script>

<svelte:head><title>{group.name} members — atmo.rsvp</title></svelte:head>

<div class="mx-auto max-w-3xl px-6 py-8 sm:py-12">
	<a
		href="/groups/{group.slug}"
		class="text-base-500 dark:text-base-400 mb-4 inline-block text-sm hover:underline"
		>← {group.name}</a
	>

	<h1 class="mb-6 text-3xl font-bold">Members</h1>

	{#if formError}
		<p class="mb-6 text-sm text-red-600 dark:text-red-400">{formError}</p>
	{/if}

	<ul class="flex flex-col gap-2">
		{#each data.members as member (member.membership_id)}
			<li class="ring-base-200 dark:ring-base-800 rounded-xl p-3 ring-1">
				<div class="flex flex-wrap items-center justify-between gap-3">
					<div class="min-w-0">
						<p class="font-mono text-xs break-all">{member.did}</p>
						<div class="mt-1 flex items-center gap-2">
							<Badge variant={member.role === 'owner' ? 'primary' : 'secondary'}>
								{member.role}
							</Badge>
							{#if member.status !== 'active'}
								<Badge variant="secondary">{member.status}</Badge>
							{/if}
						</div>
					</div>

					{#if data.canManageMembers && member.role !== 'owner'}
						<div class="flex shrink-0 flex-wrap items-center gap-2">
							<form {...changeMemberRoleForm} class="flex items-center gap-1">
								<input type="hidden" name="slug" value={group.slug} />
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
							<form {...setMemberStatusForm}>
								<input type="hidden" name="slug" value={group.slug} />
								<input type="hidden" name="did" value={member.did} />
								<input
									type="hidden"
									name="status"
									value={member.status === 'active' ? 'suspended' : 'active'}
								/>
								<Button type="submit" size="sm" variant="ghost">
									{member.status === 'active' ? 'Suspend' : 'Reinstate'}
								</Button>
							</form>
							<form {...removeMemberForm}>
								<input type="hidden" name="slug" value={group.slug} />
								<input type="hidden" name="did" value={member.did} />
								<button type="submit" class="text-xs text-red-600 hover:underline dark:text-red-400"
									>Remove</button
								>
							</form>
						</div>
					{:else if member.role === 'owner'}
						<span class="text-base-400 dark:text-base-500 shrink-0 text-xs"
							>owner — cannot be changed</span
						>
					{/if}
				</div>
			</li>
		{/each}
	</ul>

	{#if data.canManageMembers}
		<section class="mt-10">
			<h2 class="mb-3 text-xl font-semibold">Pending requests</h2>
			{#if data.pendingRequests.length === 0}
				<p class="text-base-500 dark:text-base-400 text-sm">None.</p>
			{:else}
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
							<div class="flex shrink-0 items-center gap-2">
								<form {...approveJoinRequestForm} class="flex items-center gap-1">
									<input type="hidden" name="slug" value={group.slug} />
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
								<form {...rejectJoinRequestForm}>
									<input type="hidden" name="slug" value={group.slug} />
									<input type="hidden" name="requestId" value={request.id} />
									<Button type="submit" size="sm" variant="ghost">Reject</Button>
								</form>
							</div>
						</li>
					{/each}
				</ul>
			{/if}

			<h2 class="mt-8 mb-3 text-xl font-semibold">Add a member directly</h2>
			<form {...addMemberForm} class="flex flex-wrap items-end gap-2">
				<input type="hidden" name="slug" value={group.slug} />
				<div class="flex flex-col gap-1.5">
					<Label for="add-did">DID</Label>
					<Input id="add-did" name="did" placeholder="did:plc:…" required class="w-72 font-mono" />
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

		<section class="mt-10">
			<h2 class="mb-3 text-xl font-semibold">What each role grants</h2>
			<p class="text-base-500 dark:text-base-400 mb-3 text-sm">
				Permissions are stored per group. Names shown in grey are stored but have no handler in this
				version — nothing grants on them.
			</p>
			<div class="flex flex-col gap-3">
				{#each Object.entries(data.rolePermissions) as [role, permissions] (role)}
					<div class="ring-base-200 dark:ring-base-800 rounded-xl p-3 ring-1">
						<p class="mb-2 font-semibold">{role}</p>
						<div class="flex flex-wrap gap-1.5">
							{#each permissions as permission (permission)}
								<span
									class="rounded-full px-2 py-0.5 font-mono text-xs {inert.has(permission)
										? 'bg-base-100 text-base-400 dark:bg-base-900 dark:text-base-500'
										: 'bg-accent-400/10 text-accent-700 dark:text-accent-400'}"
								>
									{permission}
								</span>
							{/each}
						</div>
					</div>
				{/each}
			</div>
		</section>
	{/if}
</div>
