<script lang="ts">
	import { Button } from '@atmo-dev/kit';
	import { isHttpError } from '@sveltejs/kit';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import GroupSettingsFields from '#lib/groups/components/GroupSettingsFields.svelte';
	import { saveGroupSettings } from '#lib/groups/group.remote.js';

	let { data } = $props();

	let busy = $state(false);
	let failure: string | null = $state(null);

	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (data.reapprove) return;
		const form = new FormData(event.currentTarget as HTMLFormElement);
		busy = true;
		failure = null;
		try {
			await saveGroupSettings({
				groupDid: data.group.did,
				shownPublic: data.settings.public,
				settings: {
					name: String(form.get('name') ?? ''),
					description: String(form.get('description') ?? ''),
					website: String(form.get('website') ?? ''),
					joinPolicy: String(form.get('joinPolicy') ?? ''),
					public: form.get('visibility') === 'public',
					listed: form.get('listed') === 'on'
				}
			});
			await goto(resolve('/(app)/groups/[actor]', { actor: data.group.did }), {
				invalidateAll: true
			});
		} catch (e) {
			// The server says why where it can: the form, the caller's role, or a broken link.
			failure =
				isHttpError(e, 400) || isHttpError(e, 403)
					? e.body.message
					: 'Saving did not work. Try again.';
		} finally {
			busy = false;
		}
	}
</script>

<div class="min-h-screen px-6 py-12 sm:py-12">
	<div class="mx-auto max-w-2xl">
		<div class="mb-6">
			<a
				href={resolve('/(app)/groups/[actor]', { actor: data.group.did })}
				class="text-accent-600 hover:text-accent-700 dark:text-accent-400 dark:hover:text-accent-300 text-sm font-medium transition-colors"
			>
				&larr; {data.group.name}
			</a>
		</div>
		<h1 class="text-base-900 dark:text-base-50 text-2xl font-bold">Settings</h1>

		{#if data.reapprove}
			<form method="POST" action="/oauth/group/link" class="mt-6 space-y-3">
				<input type="hidden" name="group" value={data.group.did} />
				<p class="text-base-700 dark:text-base-300 text-sm">
					Your link to this group was approved before atmo could change a group's settings. Approve
					it again at the group host to change them here.
				</p>
				<Button type="submit" variant="primary">Approve again</Button>
			</form>
		{:else}
			{#if failure}<p role="alert" class="text-base-950 dark:text-base-50 mt-4 text-sm">
					{failure}
				</p>{/if}
			<form class="mt-6 space-y-5" onsubmit={save}>
				<GroupSettingsFields
					name={data.settings.name}
					description={data.settings.description ?? ''}
					website={data.settings.website ?? ''}
					joinPolicy={data.settings.joinPolicy ?? ''}
					isPublic={data.settings.public}
					listed={data.settings.listed}
				/>
				<Button type="submit" variant="primary" disabled={busy}>Save</Button>
			</form>
		{/if}
	</div>
</div>
