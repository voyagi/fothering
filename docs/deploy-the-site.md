# Deploy the site

The site is static: the build writes it to `packages/web/dist`, and Cloudflare Workers serves those
files as static assets under the Worker that `packages/web/wrangler.jsonc` names. Deploying
publishes that folder. The operator deploys it by hand, signed in to their own Cloudflare account.
No script, npm script or CI step in this repository runs the deploy command, and nothing here holds
a Cloudflare credential.

## Build

Run `npm run build` from the repository root, on the commit you are about to deploy:

```sh
npm run build
```

## Set the origin

The site's absolute links come from one setting, `SITE_ORIGIN` in
`packages/web/src/site/route-list.ts`. Before the first deploy:

1. Read the address Cloudflare will serve the Worker at.
2. If the account's Workers subdomain in that address holds a personal name, replace it first, with
   a custom domain or a renamed subdomain, so no personal name is published.
3. Commit that origin as `SITE_ORIGIN`.
4. Build and deploy from the commit that sets `SITE_ORIGIN`, so the published links and the
   committed origin agree.

## Sign in

The deploy runs as the operator's own Cloudflare login:

```sh
npx wrangler@4.151.1 login
```

## Deploy

Run the one deploy command from `packages/web`, the folder that holds its configuration file, so
the configuration file and the asset folder it names are read from the same place:

```sh
cd packages/web
npx wrangler@4.151.1 deploy --config wrangler.jsonc
```

The command pins one exact wrangler version. Using a different version needs a commit to this
document first, so the version that published the site is always the one written here.
