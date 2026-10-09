<script lang="ts">
	import { Button } from '@foxui/core';
	import { groupFormError, resetOnSuccess } from '../form-result';
	import { approveJoinRequestForm, rejectJoinRequestForm } from '../roster.remote';
	import type { AssignableRole } from '../permissions';
	import type { JoinRequestRow, Person } from '../types';
	import PersonLabel from './PersonLabel.svelte';

	// One pending join request, with Approve and Reject. With `roles`, the
	// approver picks the new member's role; without, they join as a member.
	let {
		groupDid,
		request,
		person,
		roles
	}: {
		groupDid: string;
		request: Pick<JoinRequestRow, 'id' | 'did' | 'message'>;
		person?: Person;
		roles?: readonly AssignableRole[];
	} = $props();

	// One form instance per row: a remote form object attaches to one `<form>` only.
	let approveForm = $derived(approveJoinRequestForm.for(request.id));
	let rejectForm = $derived(rejectJoinRequestForm.for(request.id));
	let requestError = $derived(
		groupFormError(approveForm.result) ?? groupFormError(rejectForm.result)
	);
</script>

<li
	class="ring-base-200 dark:ring-base-800 flex flex-wrap items-center justify-between gap-3 rounded-xl p-3 ring-1"
>
	<div class="min-w-0">
		<PersonLabel did={request.did} {person} />
		{#if request.message}
			<p class="text-base-500 dark:text-base-400 mt-2 text-sm">{request.message}</p>
		{/if}
	</div>
	<div class="flex shrink-0 items-center gap-2">
		<form {...resetOnSuccess(approveForm)} class="flex items-center gap-1">
			<input type="hidden" name="groupDid" value={groupDid} />
			<input type="hidden" name="requestId" value={request.id} />
			{#if roles}
				<select
					name="role"
					class="ring-base-200 dark:ring-base-800 bg-base-100/50 dark:bg-base-900/50 rounded-ui border-0 px-2 py-1 text-xs ring-1 ring-inset"
				>
					{#each roles as role (role)}
						<option value={role} selected={role === 'member'}>{role}</option>
					{/each}
				</select>
			{:else}
				<input type="hidden" name="role" value="member" />
			{/if}
			<Button type="submit" size="sm">Approve</Button>
		</form>
		<form {...resetOnSuccess(rejectForm)}>
			<input type="hidden" name="groupDid" value={groupDid} />
			<input type="hidden" name="requestId" value={request.id} />
			<Button type="submit" size="sm" variant="ghost">Reject</Button>
		</form>
	</div>
	{#if requestError}
		<p class="w-full text-sm text-red-600 dark:text-red-400">{requestError}</p>
	{/if}
</li>
