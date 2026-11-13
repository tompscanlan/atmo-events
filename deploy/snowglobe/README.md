# atmo on a snowglobe globe

How the atmo that runs on a globe (lighthouse today, at https://atmo.lighthouse.snowglobe.at) is
built and updated. Each script's header has its own details; this page covers the order of steps
and the parts that live outside this repo.

## Which branch is deployed

This branch, `deploy/lighthouse-private-events-6`, runs a person's private events, so people can
try them on a globe. It is `feat/private-events-4`, the code of pull request #105 (at `e56ede18`,
on Bluesky's 11/12 spaces alpha), plus three commits of our own that never go upstream:

```
upstream/main (flo-bit)
  └ feat/private-events-4                 #105: private events on a person's own account
     └ deploy/lighthouse-private-events-6  + the demo strip (PUBLIC_NETWORK_NOTICE)
                                           + this folder
                                           + pnpm-workspace.yaml: the 11/12 alpha packages exempt
                                             from pnpm's 24 h release-age wait, by exact version
```

The last one only let the image build on the day the alpha came out. It can be dropped from the
next rebuild: #105 keeps the wait.

It has no groups code: that stack comes back on top of the private events branch later. The groups
on a globe stay on its group host and PDS, but this build has no pages for them.

It is rebuilt, not merged: the three commits are cherry-picked onto #105's newest head. A rebuild
gets a new branch name, so the commit behind the last image stays on the fork; a fix to the same
build fast-forwards it.

## What the globe must run

- **A PDS on the same spaces alpha as #105.** #105 follows the 11/12 alpha (permissioned-data-alpha
  `b27a037c7`) and calls its methods, so a globe whose PDS runs an older alpha breaks every private
  event page, and an older atmo breaks on an 11/12 PDS. When the alpha moves, the PDS and atmo move
  in one lab-infra commit. The PDS migrates its databases (on start, and per account on first open),
  so it cannot go back by image alone: back up its `/data` first.
- **The space type `rsvp.atmo.dev.space`** (apps/web/lexicons/spaces/rsvp/atmo/dev/space.json),
  published where the globe's PDSes look for lexicons, before anyone's first private-event
  permission: a failed lookup sticks for about 5 minutes. Its `title` is what the 11/12 consent
  screen shows; without it the screen shows the type's name.

## Settings

The network settings (`PUBLIC_PLC_URL` and the rest, apps/web/.env.example) plus
`PRIVATE_EVENTS=true`, `SPACES_PDS_URL` and the demo strip's `PUBLIC_NETWORK_NOTICE` and
`PUBLIC_NETWORK_NOTICE_URL`, all read when atmo starts. Secrets: `COOKIE_SECRET`,
`CLIENT_ASSERTION_KEY` and `CRON_SECRET` (seal-secrets.sh). The worker's timer posts to
`/api/cron` with `CRON_SECRET`, so without it nothing is ingested.

## Build, check, push the image

From the repo root of a clean checkout of this branch:

```
T=$(git rev-parse --short=12 HEAD)
docker build -q -f deploy/snowglobe/Dockerfile -t ghcr.io/openmeet-team/snowglobe-atmo:$T .
```

Check the image before pushing. Offline, it should start with no network and serve its home page.
The image has no wget or curl, so use node:

```
docker run -d --name atmo-smoke --network none -e ATMO_PUBLIC_HOST=atmo.smoke.test \
  -e ATMO_ENV_FILES=/config/vars.env -v "$PWD/empty.env:/config/vars.env:ro" \
  -v "$PWD/data:/data" ghcr.io/openmeet-team/snowglobe-atmo:$T
docker exec atmo-smoke node -e 'fetch("http://127.0.0.1:8787/").then(r=>console.log(r.status))'
docker rm -f atmo-smoke
```

Then on the globe's own settings: its pages answer, and `/oauth-client-metadata.json` (without
`jwks`) matches the running atmo's. If it differs, a lexicon step comes first, and the PDS caches
client metadata for about 10.5 minutes, so read a sign-in failure after a deploy only after that.

A change to server-side fetches also gets a walk as a built Worker on a local globe before the
push: vite dev allows calls a built Worker refuses.

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
`main`; a PDS move goes in the same commit (`globes/<globe>/snowglobe.yml`, then snowglobe-cloud's
`k8s/stamp.mjs` writes `10-workloads.yaml`). This is a production deploy: an agent needs Tom's go,
and the auto-mode classifier may block an agent's push there even with that go, so then Tom runs
the push.

Each boot applies the og image's tables (run.sh). A new D1 migration from upstream would need
the same treatment; check `apps/web/migrations` in the merge.

After the rollout, check from outside the cluster: the pages answer, the demo strip shows, the
demo events list, images load, and the timer's ingest runs with no failed ticks. Then sign in as
the seeded people: `deploy/snowglobe/seed.sh <globe>` is a no-op when the globe is already seeded
and supplies their logins to a check script. `walk.mjs` and `probe-proposal.mjs` here are from the
groups line (group create, joins, opensocial.group cases); this build has no group pages, so they
do not apply to it.

The checks need Playwright; the scripts' headers say where they find it. To run one from a phone
instead of a desktop browser, add `SEED_DEVICE='Pixel 7'` (any Playwright device name; it is still
Chromium, so an Android device is the faithful one).

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
