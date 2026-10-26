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
</script>

<AtprotoLoginModal
	bind:open={atProtoLoginModalState.open}
	host={network().appviewUrl}
	login={async (handle) => {
		await login(handle);
		return true;
	}}
	signup={async () => {
		signup();
		return true;
	}}
/>
