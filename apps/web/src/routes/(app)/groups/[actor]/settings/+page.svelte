<script lang="ts">
	import { Button } from '@atmo-dev/kit';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import GroupSettingsFields from '#lib/groups/components/GroupSettingsFields.svelte';
	import { saveGroupSettings } from '#lib/groups/group.remote.js';

	let { data } = $props();

	let busy = $state(false);
	let failure: string | null = $state(null);

	async function save(event: SubmitEvent) {
		event.preventDefault();
		const form = new FormData(event.currentTarget as HTMLFormElement);
		busy = true;
		failure = null;
		try {
			await saveGroupSettings({
				groupDid: data.group.did,
				shownPublic: data.settings.isPublic,
				settings: {
					name: form.get('name'),
					description: form.get('description') ?? '',
					joinPolicy: form.get('joinPolicy'),
					public: form.get('visibility') === 'public',
					listed: form.get('listed') === 'on'
				}
			});
			await goto(resolve('/(app)/groups/[actor]', { actor: data.group.did }), {
				invalidateAll: true
			});
		} catch (e) {
			const message = (e as { body?: { message?: unknown } })?.body?.message;
			failure = typeof message === 'string' ? message : 'Saving did not work. Try again.';
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
		{#if failure}<p role="alert" class="mt-4 text-sm text-red-600">{failure}</p>{/if}
		<form class="mt-6 space-y-5" onsubmit={save}>
			<GroupSettingsFields {...data.settings} />
			<Button type="submit" variant="primary" disabled={busy}>Save</Button>
		</form>
	</div>
</div>
