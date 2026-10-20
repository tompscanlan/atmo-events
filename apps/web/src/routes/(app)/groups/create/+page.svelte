<script lang="ts">
	import { Button, Input, Label } from '@foxui/core';

	import { page } from '$app/state';
	import { groupFormError, resetOnSuccess } from '$lib/groups/form-result';
	import { GROUP_AVATAR_MAX_BYTES, GROUP_AVATAR_TYPES } from '$lib/groups/about-record';
	import { createGroupForm } from '$lib/groups/group.remote';
	import { FIELD_CLASS } from '$lib/groups/components/field-class';

	let { data } = $props();

	// A private group is invite-only, and the groups table refuses one that does
	// not require approval, so the form shows approval as fixed-on rather than
	// letting the combination be picked and then refused on submit.
	let visibility = $state('public');
	// A create comes back from the host's callback with its error
	// in the address, since the host made the group before this site set it up.
	let createError = $derived(
		groupFormError(createGroupForm.result) ?? page.url.searchParams.get('error') ?? undefined
	);
	// The form's success is the host's sign-up page, where the
	// creator picks the address and approves this site.
	let signUpUrl = $derived.by(() => {
		const result = createGroupForm.result;
		return result?.ok && 'signUpUrl' in result ? result.signUpUrl : undefined;
	});
	$effect(() => {
		if (signUpUrl) window.location.assign(signUpUrl);
	});
</script>

<svelte:head><title>New group - atmo.rsvp</title></svelte:head>

<div class="mx-auto max-w-2xl px-6 py-8 sm:py-12">
	<h1 class="mb-2 text-3xl font-bold">New group</h1>
	<p class="text-base-500 dark:text-base-400 mb-4 text-sm">
		A group is an account on the network. Creating one registers a new identity. Its address becomes
		its handle, so the name has to be free.
	</p>
	<!-- Says who holds what: the host holds the account, nobody has a password
	     for it, and the creator approves this site at the host as themselves. -->
	<p class="text-base-500 dark:text-base-400 mb-8 text-sm">
		<strong>The group's host makes its account.</strong> After this form you go to the host, choose the
		group's address there, sign in with your own account and approve this site to act for the group. Nobody
		holds a password for the group: you act for it as yourself, as its first admin.
	</p>

	{#if !data.canCreate}
		<div
			class="ring-base-200 dark:ring-base-800 text-base-600 dark:text-base-300 mb-8 rounded-2xl p-4 text-sm ring-1"
		>
			<p class="font-semibold">Group creation is not configured on this deployment.</p>
			<p class="mt-1">
				An administrator needs to set <code class="font-mono">GROUP_HOST_URL</code> and
				<code class="font-mono">OAUTH_PUBLIC_URL</code>, and bind the
				<code class="font-mono">OAUTH_SESSIONS</code> store, first.
			</p>
		</div>
	{/if}

	<!-- A deployment that cannot create one gets no form, only the notice above. -->
	{#if data.canCreate}
		<form
			{...resetOnSuccess(createGroupForm)}
			enctype="multipart/form-data"
			class="flex flex-col gap-5"
		>
			<div class="flex flex-col gap-1.5">
				<Label for="group-name">Name</Label>
				<Input id="group-name" name="name" required maxlength={120} />
			</div>

			<div class="flex flex-col gap-1.5">
				<Label for="group-avatar">Picture</Label>
				<input
					id="group-avatar"
					name="avatar"
					type="file"
					accept={GROUP_AVATAR_TYPES.join(',')}
					class="text-sm"
				/>
				<p class="text-base-500 dark:text-base-400 text-xs">
					Optional. A PNG, JPEG or WebP image of at most {GROUP_AVATAR_MAX_BYTES / 1_000_000} MB, shown
					beside the group's name. It is kept in the group's about space, so only people who may read
					the group see it.
				</p>
			</div>

			<div class="flex flex-col gap-1.5">
				<Label for="group-description">Description</Label>
				<textarea
					id="group-description"
					name="description"
					rows="4"
					maxlength="4000"
					class={FIELD_CLASS}
				></textarea>
			</div>

			<div class="flex flex-col gap-1.5">
				<Label for="group-rules">Rules</Label>
				<textarea
					id="group-rules"
					name="rules"
					rows="4"
					maxlength="8000"
					placeholder="One rule per line"
					class={FIELD_CLASS}
				></textarea>
				<p class="text-base-500 dark:text-base-400 text-xs">
					Optional, and editable later. Each line becomes its own record in the group’s about space,
					so a rule keeps one stable address even as the list changes.
				</p>
			</div>

			<div class="flex flex-col gap-1.5">
				<Label for="group-visibility">Visibility</Label>
				<select id="group-visibility" name="visibility" bind:value={visibility} class={FIELD_CLASS}>
					<option value="public">public: listed and browsable</option>
					<option value="private">private: members only</option>
				</select>
			</div>

			<!-- No space URI field: the host makes the group's spaces. The URIs
		     appear on the group page. -->

			<!-- A disabled checkbox is never submitted, and an absent checkbox parses as
		     "off", so the fixed-on case sends its value through a hidden input. -->
			{#if visibility === 'private'}
				<input type="hidden" name="requireApproval" value="on" />
				<label class="flex items-center gap-2 text-sm">
					<input type="checkbox" checked disabled class="size-4" />
					Require approval to join
				</label>
				<p class="text-base-500 dark:text-base-400 -mt-3 text-xs">
					A private group is invite-only, so approval is always on.
				</p>
			{:else}
				<label class="flex items-center gap-2 text-sm">
					<input type="checkbox" name="requireApproval" checked class="size-4" />
					Require approval to join
				</label>
			{/if}

			{#if signUpUrl}
				<p class="text-sm">
					Taking you to the group host to sign up the group.
					<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the host's page, not a route here -->
					<a class="underline" href={signUpUrl}>Continue</a> if nothing happens.
				</p>
			{/if}

			{#if createError}
				<p class="text-sm text-red-600 dark:text-red-400">{createError}</p>
			{/if}

			<div>
				<Button type="submit">Create group</Button>
			</div>
		</form>
	{/if}
</div>
