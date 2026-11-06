#!/bin/sh
set -eu

# Make a snowglobe atmo's secrets fresh and seal them for its namespace, as Secret
# atmo-secrets holding one file, secrets.env (run.sh reads it from /secrets):
#   COOKIE_SECRET         signs atmo's cookies
#   CLIENT_ASSERTION_KEY  the OAuth client's private key (a P-256 JWK, kid main-key)
#   CRON_SECRET           guards /api/cron (unset, the route would let anyone in)
# Every value is made now and goes straight into kubeseal; none is printed or kept.
#
# Usage: SEALED_KEYS_CAPTURED=1 deploy/snowglobe/seal-secrets.sh <namespace> <out.yaml> [--rotate]
#
#   SEALED_KEYS_CAPTURED=1  your word that the sealed-secrets controller's keys were exported
#                           to 1Password before this seal (a seal binds to the newest key).
#   --rotate                replace an existing <out.yaml>. Everyone signed in is signed out.
#
# Needs: this checkout's node_modules (pnpm install), kubeseal, and kubectl on the cluster
# that runs the atmo.

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NS="${1:?Usage: seal-secrets.sh <namespace> <out.yaml> [--rotate]}"
OUT="${2:?Usage: seal-secrets.sh <namespace> <out.yaml> [--rotate]}"

[ "${SEALED_KEYS_CAPTURED:-}" = 1 ] || {
  echo "seal: export the sealed-secrets controller keys to 1Password first, then rerun with SEALED_KEYS_CAPTURED=1" >&2
  exit 3
}
if [ -f "${OUT}" ] && [ "${3:-}" != "--rotate" ]; then
  echo "seal: ${OUT} exists; pass --rotate to replace it (signs everyone out)" >&2
  exit 4
fi
echo "seal: cluster context $(kubectl config current-context), namespace ${NS}" >&2

umask 077
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

# The JWK holds double quotes, so it is single-quoted: dotenv takes that literally.
(cd "${ROOT}/apps/web" && node --input-type=module -e "
import { randomBytes } from 'node:crypto';
import { generateClientAssertionKey } from '@atcute/oauth-node-client';
const key = await generateClientAssertionKey('main-key');
const s = () => randomBytes(32).toString('base64url');
process.stdout.write('COOKIE_SECRET=' + s() + '\n');
process.stdout.write(\"CLIENT_ASSERTION_KEY='\" + JSON.stringify(key) + \"'\n\");
process.stdout.write('CRON_SECRET=' + s() + '\n');
") > "${TMP}/secrets.env"
[ "$(grep -c -E '^(COOKIE_SECRET|CLIENT_ASSERTION_KEY|CRON_SECRET)=.' "${TMP}/secrets.env")" = 3 ] || {
  echo "seal: making the secrets failed" >&2
  exit 1
}

{
  echo "apiVersion: v1"
  echo "kind: Secret"
  echo "metadata: { name: atmo-secrets, namespace: ${NS} }"
  echo "data:"
  echo "  secrets.env: $(base64 -w0 < "${TMP}/secrets.env")"
} > "${TMP}/secret.yaml"
kubeseal --format yaml --scope strict \
  --controller-name sealed-secrets-controller --controller-namespace kube-system \
  < "${TMP}/secret.yaml" > "${TMP}/sealed.yaml"
{
  echo "# Sealed for ${NS} by atmo-events deploy/snowglobe/seal-secrets.sh: COOKIE_SECRET,"
  echo "# CLIENT_ASSERTION_KEY and CRON_SECRET in secrets.env. Only the cluster's key opens it."
  cat "${TMP}/sealed.yaml"
} > "${OUT}"
echo "seal: wrote ${OUT}" >&2
