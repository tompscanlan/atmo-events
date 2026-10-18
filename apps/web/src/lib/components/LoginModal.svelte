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
	import { login, signup } from '$lib/atproto';
	import { network } from '$lib/atproto/network';

	import { AtprotoLoginModal } from '@foxui/social';

	// The handle search asks the public Bluesky API unless the deployment names
	// another (or none, on a network that has no such service).
	const appviewUrl = network().appviewUrl;
</script>

<AtprotoLoginModal
	bind:open={atProtoLoginModalState.open}
	host={appviewUrl ?? undefined}
	search={appviewUrl ? undefined : async () => []}
	login={async (handle) => {
		await login(handle);
		return true;
	}}
	signup={async () => {
		signup();
		return true;
	}}
/>
