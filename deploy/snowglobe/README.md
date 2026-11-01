# atmo on a snowglobe globe

How the atmo that runs on a globe (lighthouse today, at https://atmo.lighthouse.snowglobe.at) is
built and updated. Each script's header has its own details; this page covers the order of steps
and the parts that live outside this repo.

## Which branch is deployed

This branch, `deploy/lighthouse-prs-2`, runs the commits we send upstream, so reviewers can try
them on a globe. It is a stack of PRs, each a branch of final-state commits on the one below, so
each release can take the ones it wants; then two commits of our own that never go upstream:

```
upstream/main (flo-bit, the UI redesign, SvelteKit 3, contrail 0.27)
  └ feat/network-addresses-4   the network PR: atmo pointed at a network other than Bluesky
     └ feat/groups-link-6       link a group, list it, post its events as the group
        └ feat/groups-members-4  a person's group permissions, roster, members-only events
           └ deploy/lighthouse-prs-2  + the demo strip (PUBLIC_NETWORK_NOTICE) and this folder
```

It is rebuilt, not merged: when a PR changes, rebuild every branch above it under a new name
(`-N+1`) rather than force-pushing. The settings are the network PR's (`PUBLIC_PLC_URL` and the
rest, apps/web/.env.example) plus `GROUP_HOST_URL`, `SPACES_PDS_URL` and the demo strip's
`PUBLIC_NETWORK_NOTICE` and `PUBLIC_NETWORK_NOTICE_URL`, all read when atmo starts. Two names
changed from the pre-redesign line: `PUBLIC_JETSTREAM_URLS` is now `PUBLIC_JETSTREAM_URL` (one
origin), and `PUBLIC_IMAGE_URL_TEMPLATE` is now `PUBLIC_CDN_URL` (the CDN's origin; atmo adds
`/img/<preset>/plain/<did>/<cid>@<format>`).

Secrets are unchanged: `COOKIE_SECRET`, `CLIENT_ASSERTION_KEY` and `CRON_SECRET`
(seal-secrets.sh). The worker's timer posts to `/api/cron` with `CRON_SECRET`, so without it
nothing is ingested.

The pre-redesign line, `deploy/lighthouse-prs`, is what lighthouse ran until this branch. Its
contrail 0.12 tables are converted in place on the first start (upstream's contrail upgrade;
apps/web/src/lib/contrail/fts-indexing.test.ts). Rehearse the move on a copy of the data volume
before switching a globe that holds groups.

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
