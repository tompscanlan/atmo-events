#!/bin/sh
set -eu

# Seed a globe's atmo (seed.mjs) as an operator step from outside, through the public names.
#
#   deploy/snowglobe/seed.sh <globe> [script]   e.g. lighthouse; script defaults to seed.mjs
#
# walk.mjs, the walk checks on a seeded globe, runs the same way and with the same logins.
#
# Reads from the cluster (the current kubectl context, printed first): the seed's invite code
# (Secret globe-seed-invite, which reset.sh makes, else the operator's in globe-operator-logins) and any logins an earlier run kept (Secret globe-seed-logins,
# both in namespace snowglobe-<globe>). Writes the logins back to globe-seed-logins on the way
# out, failed run or not, so an account made here is never left without its password. Read
# them with:
#
#   kubectl get secret -n snowglobe-<globe> globe-seed-logins -o json | jq '.data | map_values(@base64d)'
#
# Server-side apply, so no copy of the values lands in a last-applied annotation. Nothing
# secret is printed. Env passed through: SEED_ONLY, SEED_PLAYWRIGHT, SEED_SHOTS (a directory
# for screenshots of the browser steps), SEED_DEVICE (a phone to act from, e.g. 'Pixel 7').

GLOBE="${1:?usage: seed.sh <globe> [script]}"
SCRIPT="${2:-seed.mjs}"
NS="snowglobe-${GLOBE}"
DOMAIN="${GLOBE}.snowglobe.at"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "seed.sh: kubectl context $(kubectl config current-context), namespace ${NS}"

umask 077
WORK="$(mktemp -d)"
LOGINS="${WORK}/logins.env"
INVITE="${WORK}/invite.env"

keep_logins() {
  if [ -s "${LOGINS}" ]; then
    kubectl create secret generic globe-seed-logins -n "${NS}" --from-env-file="${LOGINS}" \
      --dry-run=client -o json \
      | jq '.metadata.labels = {"snowglobe/purpose": "seed-logins"}' \
      | kubectl apply --server-side --force-conflicts --field-manager=seed-sh -f - >/dev/null
    echo "seed.sh: logins kept in ${NS}/globe-seed-logins ($(grep -c _PASSWORD= "${LOGINS}") people)"
  fi
  rm -rf "${WORK}"
}
trap keep_logins EXIT

if kubectl get secret -n "${NS}" globe-seed-logins >/dev/null 2>&1; then
  kubectl get secret -n "${NS}" globe-seed-logins -o json \
    | jq -r '.data | to_entries[] | "\(.key)=\(.value | @base64d)"' >"${LOGINS}"
else
  : >"${LOGINS}"
fi
# reset.sh mints the seed its own invite (Secret globe-seed-invite), since the operator's runs out.
INVITE_SECRET=globe-operator-logins
kubectl get secret -n "${NS}" globe-seed-invite >/dev/null 2>&1 && INVITE_SECRET=globe-seed-invite
kubectl get secret -n "${NS}" "${INVITE_SECRET}" -o json \
  | jq -r '"SEED_INVITE_CODE=\(.data.INVITE_CODE | @base64d)"' >"${INVITE}"

SEED_ATMO="https://atmo.${DOMAIN}" \
SEED_PDS="https://alpha.${DOMAIN}" \
SEED_DOMAIN="${DOMAIN}" \
SEED_LOGINS_FILE="${LOGINS}" \
SEED_INVITE_FILE="${INVITE}" \
  node "${HERE}/${SCRIPT}"
