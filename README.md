
# siteproxy

It's a fork of [netptop/siteproxy](https://github.com/netptop/siteproxy), a online web proxy tool.
It removes the obfuscation & JavaScript encryption from original project
and simplify configuration & deployment procedures.

- [siteproxy](#siteproxy)
- [Run \& Deploy](#run--deploy)
  - [Run in Cloudflare Workers environment](#run-in-cloudflare-workers-environment)
  - [Run in node.js development environment](#run-in-nodejs-development-environment)
  - [Run in node.js production environment](#run-in-nodejs-production-environment)
  - [Run in Cloudflare Workers local development environment](#run-in-cloudflare-workers-local-development-environment)

# Run & Deploy

## Run in Cloudflare Workers environment

Fork and connect this project to Cloudflare Workers and configure it as below:

Variables and Secrets (runtime):

- `PROXY_URL` : Set to your worker domain origin, with optional path prefix.
E.g. `https://siteproxy.user.workers.dev` or `https://siteproxy.user.workers.dev/proxy/` .
- (optional) `HIDE_HEADER` : Set to `1` to hide page header bar.

Build config:

- Build command: None
- Deploy command: `npm run cfdeploy`
- Version command: `npm run cfdeploy`
- Root directory: `/`

Deploy. Then open `PROXY_URL` in browser.

## Run in node.js development environment

```
npm i
npm run build
npm start
```

Open http://localhost:5006/ in browser.

## Run in node.js production environment

1. (optional) Set the `PORT` to listening port, default is `5006`.
2. Set the `PROXY_URL` env.

```
npm i
npm run build
node index.js
```

Open `PROXY_URL` in browser.

## Run in Cloudflare Workers local development environment

1. (optional) Create `.env.local` env file to configure `PROXY_URL` and other variables.
2. `npm i`
3. `npm run cfdev`

Open `PROXY_URL` in browser.

