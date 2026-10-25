<script lang="ts">
	import { Button, Input, Label } from '@foxui/core';

	import { page } from '$app/state';
	import { groupFormError, resetOnSuccess } from '$lib/groups/form-result';
	import { GROUP_DESCRIPTION_MAX, GROUP_NAME_MAX } from '$lib/groups/about-record';
	import { createGroupForm } from '$lib/groups/group.remote';
	import { FIELD_CLASS } from '$lib/groups/components/field-class';

	let { data } = $props();

	// The host's callback reports its error in the address.
	let createError = $derived(
		groupFormError(createGroupForm.result) ?? page.url.searchParams.get('error') ?? undefined
	);
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

	{#if data.canCreate}
		<form {...resetOnSuccess(createGroupForm)} class="flex flex-col gap-5">
			<div class="flex flex-col gap-1.5">
				<Label for="group-name">Name</Label>
				<Input id="group-name" name="name" required maxlength={GROUP_NAME_MAX} />
			</div>

			<div class="flex flex-col gap-1.5">
				<Label for="group-description">Description</Label>
				<textarea
					id="group-description"
					name="description"
					rows="4"
					maxlength={GROUP_DESCRIPTION_MAX}
					class={FIELD_CLASS}
				></textarea>
			</div>

			<div class="flex flex-col gap-1.5">
				<Label for="group-rules">Rules</Label>
				<textarea
					id="group-rules"
					name="rules"
					rows="4"
					placeholder="One rule per line"
					class={FIELD_CLASS}
				></textarea>
				<p class="text-base-500 dark:text-base-400 text-xs">
					Optional. Each line becomes its own rule record in the group’s meta space.
				</p>
			</div>

			<div class="flex flex-col gap-1.5">
				<Label for="group-visibility">Visibility</Label>
				<select id="group-visibility" name="visibility" class={FIELD_CLASS}>
					<option value="public">public: anyone can read it</option>
					<option value="private">private: members only</option>
				</select>
			</div>

			<div class="flex flex-col gap-1.5">
				<Label for="group-join-policy">Joining</Label>
				<select id="group-join-policy" name="joinPolicy" class={FIELD_CLASS}>
					<option value="approval">Anyone can ask; an admin approves</option>
					<option value="open">Anyone can join</option>
					<option value="invite">Invite only</option>
				</select>
			</div>

			<label class="flex items-center gap-2 text-sm">
				<input type="checkbox" name="listed" checked class="size-4" />
				List this group in browse (public groups only)
			</label>

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
