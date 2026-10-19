# atmo on a snowglobe globe

How the atmo that runs on a globe (lighthouse today, at https://atmo.lighthouse.snowglobe.at) is
built and updated. Each script's header has its own details; this page covers the order of steps
and the parts that live outside this repo.

## Which branch is deployed

This branch, `deploy/snowglobe`, is the one line we deploy from. It is built from merges, never
rebased, so every push is a fast-forward:

```
upstream/main (flo-bit)
  └ feat/network-settings     atmo pointed at a network other than Bluesky
     └ feat/group-host-network  groups, their tests, the network wiring
        └ feat/group-host-adapter groups through the group host, the smoke check
           └ deploy/snowglobe       + this folder; also merges standalone fixes (fix/app-origin)
```

To take new upstream work, merge it at the bottom and then down the chain, one level at a time:

```
git merge upstream/main          # on feat/network-settings
git merge feat/network-settings  # on feat/group-host-network
git merge feat/group-host-network  # on feat/group-host-adapter
git merge feat/group-host-adapter  # on deploy/snowglobe
```

Check each level before moving to the next, and grade against the level before the merge, not
against zero: `pnpm install --frozen-lockfile`, `pnpm -r check`, `pnpm -r test`, plus
`pnpm check:e2e` in apps/web from group-host-adapter down, and `pnpm build` on this branch.

A standalone fix goes on its own branch off `upstream/main` and is merged into this branch only,
so it can still go upstream on its own.

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
