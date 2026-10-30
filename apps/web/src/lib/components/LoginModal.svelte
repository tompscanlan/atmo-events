<script lang="ts" module>
	export const atProtoLoginModalState = $state({
		open: false,
		show() {
			this.open = true;
		},
		hide() {
			this.open = false;
		}
	});
</script>

<script lang="ts">
	import { login, signup } from '#lib/atproto/auth.svelte.js';
	import { LoginDialog, createActorSearch } from '@atmo-dev/kit';
	import { loginPermissions } from '#lib/atproto/settings.js';
	import { serviceUrl } from '#lib/atproto/network.js';
	const searchActors = createActorSearch({ host: serviceUrl('appview') });
</script>

<LoginDialog
	bind:open={atProtoLoginModalState.open}
	{searchActors}
	persistRecentAccounts
	permissions={loginPermissions}
	login={async (handle, _actor, options) => {
		await login(handle, options);
		return true;
	}}
	{signup}
/>
