#!/bin/sh
set -eu

# Reset a globe's atmo demo to a fresh install, so the next seed.sh is a first run.
#
#   RESET_OK=<globe> deploy/snowglobe/reset.sh <globe>      e.g. RESET_OK=lighthouse ... lighthouse
#
# Deletes, in the current kubectl context (printed first):
#   - the seed's people (seed.mjs PEOPLE) at the globe's PDS, through its admin API from inside
#     the pds pod, so the admin password never leaves the cluster;
#   - every group at the group host, by emptying its disk (grouphost-data): the host's own tables
#     go with the groups' accounts. Its keys are in globe-secrets and stay;
#   - atmo's disk (atmo-data): D1, KV and R2. atmo makes its tables again on boot;
#   - the seed's kept logins (Secret globe-seed-logins), and mints the seed a new invite
#     (Secret globe-seed-invite), one use per person.
# Keeps every other account at the PDS (the operator's, the lexicon authority's) and the rest of
# the globe. The deleted DIDs stay in the globe's PLC; a new seed makes new ones under the same
# handles. Argo (selfHeal) puts each deleted disk back empty, and the script waits for both pods.

GLOBE="${1:?usage: RESET_OK=<globe> reset.sh <globe>}"
[ "${RESET_OK:-}" = "${GLOBE}" ] || { echo "reset.sh: set RESET_OK=${GLOBE} to delete ${GLOBE}'s demo data" >&2; exit 2; }
NS="snowglobe-${GLOBE}"
ANS="atmo-${GLOBE}"
DOMAIN="${GLOBE}.snowglobe.at"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "reset.sh: kubectl context $(kubectl config current-context), namespaces ${NS} and ${ANS}"

PEOPLE=$(sed -n "s/^[[:space:]]*{ name: '\([a-z0-9-]*\)'.*/\1/p" "${HERE}/seed.mjs")
[ -n "${PEOPLE}" ] || { echo "reset.sh: no people found in seed.mjs" >&2; exit 1; }

for name in ${PEOPLE}; do
  handle="${name}.${DOMAIN}"
  did=$(curl -s -m 15 "https://alpha.${DOMAIN}/xrpc/com.atproto.identity.resolveHandle?handle=${handle}" | jq -r '.did // empty')
  if [ -z "${did}" ]; then
    echo "  ${handle}: no account"
    continue
  fi
  status=$(kubectl exec -n "${NS}" deploy/pds -c pds -- node -e '
    const auth = Buffer.from("admin:" + process.env.PDS_ADMIN_PASSWORD).toString("base64");
    fetch("http://127.0.0.1:" + process.env.PDS_PORT + "/xrpc/com.atproto.admin.deleteAccount", {
      method: "POST",
      headers: { authorization: "Basic " + auth, "content-type": "application/json" },
      body: JSON.stringify({ did: process.argv[1] })
    }).then((r) => console.log(r.status), (e) => { console.log("error " + e.message); process.exit(1); });
  ' "${did}")
  echo "  ${handle}: ${did} deleted (${status})"
  [ "${status}" = 200 ] || exit 1
done

kubectl delete secret -n "${NS}" globe-seed-logins --ignore-not-found

# The seed's own invite, one use per person, kept in Secret globe-seed-invite for seed.sh. The
# operator's invite has a fixed number of uses, and a seed after a reset needs them all again.
# The code goes from the pds pod to the Secret through a private file and is never printed.
mint_seed_invite() {
  work="$(umask 077; mktemp -d)"
  kubectl exec -n "${NS}" deploy/pds -c pds -- node -e '
    const auth = Buffer.from("admin:" + process.env.PDS_ADMIN_PASSWORD).toString("base64");
    fetch("http://127.0.0.1:" + process.env.PDS_PORT + "/xrpc/com.atproto.server.createInviteCode", {
      method: "POST",
      headers: { authorization: "Basic " + auth, "content-type": "application/json" },
      body: JSON.stringify({ useCount: Number(process.argv[1]) })
    }).then(async (r) => { if (!r.ok) process.exit(1); console.log("INVITE_CODE=" + (await r.json()).code); },
      () => process.exit(1));
  ' "$(echo ${PEOPLE} | wc -w)" >"${work}/invite.env"
  grep -q '^INVITE_CODE=.' "${work}/invite.env" || { rm -rf "${work}"; echo "reset.sh: no invite code made" >&2; exit 1; }
  kubectl create secret generic globe-seed-invite -n "${NS}" --from-env-file="${work}/invite.env" \
    --dry-run=client -o json \
    | jq '.metadata.labels = {"snowglobe/purpose": "seed-invite"}' \
    | kubectl apply --server-side --force-conflicts --field-manager=reset-sh -f - >/dev/null
  rm -rf "${work}"
  echo "  ${NS}/globe-seed-invite: a new invite for $(echo ${PEOPLE} | wc -w) people"
}

# A claim in use is only marked for deletion; deleting the pod lets it go, and the Deployment's
# next pod waits until Argo has made the claim again.
empty_disk() {
  ns="$1"; app="$2"; pvc="$3"
  old=$(kubectl get pvc -n "${ns}" "${pvc}" -o jsonpath='{.metadata.uid}')
  kubectl delete pvc -n "${ns}" "${pvc}" --wait=false
  kubectl delete pod -n "${ns}" -l "app=${app}" --wait=true
  i=0
  until uid=$(kubectl get pvc -n "${ns}" "${pvc}" -o jsonpath='{.metadata.uid}' 2>/dev/null) \
    && [ -n "${uid}" ] && [ "${uid}" != "${old}" ]; do
    i=$((i + 1)); [ "${i}" -le 60 ] || { echo "reset.sh: Argo has not made ${ns}/${pvc} again after 10 min" >&2; exit 1; }
    sleep 10
  done
  kubectl rollout status -n "${ns}" "deploy/${app}" --timeout=600s
  echo "  ${ns}/${pvc}: empty (was ${old}, now ${uid})"
}

mint_seed_invite
empty_disk "${NS}" grouphost grouphost-data
empty_disk "${ANS}" atmo atmo-data

echo "reset.sh: done; next: deploy/snowglobe/seed.sh ${GLOBE}"
