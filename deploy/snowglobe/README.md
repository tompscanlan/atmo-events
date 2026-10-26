# atmo on a snowglobe globe

How the atmo that runs on a globe (lighthouse today, at https://atmo.lighthouse.snowglobe.at) is
built and updated. Each script's header has its own details; this page covers the order of steps
and the parts that live outside this repo.

## Which branch is deployed

This branch, `deploy/lighthouse-prs`, runs the commits we send upstream, so reviewers can try
them on a globe. It is a stack of PRs, each a branch of final-state commits on the one below, so
each release can take the ones it wants; then two commits of our own that never go upstream:

```
upstream/main (flo-bit)
  └ feat/network-settings-2   the network PR: atmo pointed at a network other than Bluesky
     └ feat/groups-host-pr-2   the groups PR, six commits
        └ feat/members-only-pr  members' acceptances and members-only events, three commits
           └ deploy/lighthouse-prs  + the demo strip (PUBLIC_NETWORK_NOTICE) and this folder
```

It is rebuilt, not merged: when a PR changes, rebase every branch above it, then the two top
commits onto the stack's new tip, and push with `--force-with-lease`. The settings are the network PR's
(`PUBLIC_PLC_URL` and the rest, apps/web/.env.example) plus `GROUP_HOST_URL`.

The older line, `deploy/snowglobe` (merges of feat/network-settings, feat/group-host-network and
feat/group-host-adapter), is what lighthouse ran until 2026-10-26. Its D1 groups tables differ
from the groups PR's, so moving a globe between the two lines means dropping atmo's groups
tables and restarting atmo: it makes them once per start, the first time it touches a group
(apps/web/src/lib/groups/server/schema.ts).

Upstream PRs are cut separately from this line, as final-state commits on `upstream/main` (the
groups cut is `feat/groups-pr` and `test/groups-e2e-pr`).

## Build, check, push the image

From the repo root of a clean checkout of this branch:

```
T=$(git rev-parse --short=12 HEAD)
docker build -q -f deploy/snowglobe/Dockerfile -t ghcr.io/openmeet-team/snowglobe-atmo:$T .
```

Check the image offline before pushing: it should start with no network and serve its home page.
The image has no wget or curl, so use node:

```
docker run -d --name atmo-smoke --network none -e ATMO_PUBLIC_HOST=atmo.smoke.test \
  -e ATMO_ENV_FILES=/config/vars.env -v "$PWD/empty.env:/config/vars.env:ro" \
  -v "$PWD/data:/data" ghcr.io/openmeet-team/snowglobe-atmo:$T
docker exec atmo-smoke node -e 'fetch("http://127.0.0.1:8787/").then(r=>console.log(r.status))'
docker rm -f atmo-smoke
```

Push to ghcr. In the scratch pod, docker's default credential helper has no ghcr login, so a
push says `denied` even after a successful login. Push with a throwaway config made from
`GH_TOKEN`, and delete it afterwards:

```
DC=$(mktemp -d); umask 077
python3 -I -c 'import os,json,base64; print(json.dumps({"auths":{"ghcr.io":{"auth":base64.b64encode(("tompscanlan:"+os.environ["GH_TOKEN"]).encode()).decode()}}}))' > $DC/config.json
DOCKER_CONFIG=$DC docker push -q ghcr.io/openmeet-team/snowglobe-atmo:$T
docker inspect --format '{{index .RepoDigests 0}}' ghcr.io/openmeet-team/snowglobe-atmo:$T
rm -rf $DC
```

## Deploy

The globe runs whatever digest `lab-infra` pins (git.tompscanlan.me/tompscanlan/lab-infra,
`globes/<globe>/atmo/workload.yaml`, both containers). ArgoCD app `atmo-<globe>` syncs it from
`main`. To deploy, change both `snowglobe-atmo@sha256:` digests to the new one, commit, and push
`main`. This is a production deploy: an agent needs Tom's go, and the auto-mode classifier
blocks an agent's push there even with that go, so Tom runs the push.

Each boot applies the og image's tables (run.sh). A new D1 migration from upstream would need
the same treatment; check `apps/web/migrations` in the merge.

After the rollout, check from outside the cluster:

```
SMOKE_URL=https://atmo.<globe>.snowglobe.at SMOKE_HANDLE=bob.<globe>.snowglobe.at \
SMOKE_OUTSIDE_HANDLE=bsky.app SMOKE_HOSTS=<globe>.snowglobe.at \
  node apps/web/scripts/smoke.mjs        # read-only, 9 checks
deploy/snowglobe/seed.sh <globe>          # a no-op when the globe is already seeded
deploy/snowglobe/seed.sh <globe> walk.mjs # Deny at sign-in and mid group create; an approval-only join
deploy/snowglobe/seed.sh <globe> probe-proposal.mjs # opensocial.group cases, puts back what it changes
```

The smoke and walk checks need Playwright; the scripts' headers say where they find it. To run
either from a phone instead of a desktop browser, add `SMOKE_DEVICE='Pixel 7'` or
`SEED_DEVICE='Pixel 7'` (any Playwright device name; it is still Chromium, so an Android device is
the faithful one). This stands in for walking it on a real phone.

## Secrets

`seal-secrets.sh` makes atmo's own secrets and seals them for the namespace. `seed.sh` keeps the
seeded people's logins in Secret `globe-seed-logins` in `snowglobe-<globe>`. Neither prints a
value.

## Not this globe: atmo.testnet

atmo.testnet.openmeet.net (Cloudflare Worker `openmeet-atmo`) is throwaway and still runs the
old `feat/groups-opensocial`. To read its deployments from the pod, the API token is in the env
but `CLOUDFLARE_ACCOUNT_ID` is an op:// reference that does not resolve here. Look the ID up
with the token and call the repo's own wrangler:

```
CLOUDFLARE_ACCOUNT_ID=$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  https://api.cloudflare.com/client/v4/accounts | jq -r '.result[0].id') \
  apps/web/node_modules/.bin/wrangler deployments list --name openmeet-atmo
```
