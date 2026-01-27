
# siteproxy

It's a fork of [netptop/siteproxy](https://github.com/netptop/siteproxy), a online web proxy tool
which uses service worker to transparently proxify any website.
It removes code obfuscation & (unnecessary) JavaScript encryption from original project,
simplifies configuration & deployment procedures, and adds new features.
It supports deployment in node.js or Cloudflare Workers environment.

- [siteproxy](#siteproxy)
- [Run \& Deploy](#run--deploy)
  - [Run in Cloudflare Workers environment](#run-in-cloudflare-workers-environment)
  - [Run in node.js development environment](#run-in-nodejs-development-environment)
  - [Run in node.js production environment](#run-in-nodejs-production-environment)
  - [Run in Cloudflare Workers local development environment](#run-in-cloudflare-workers-local-development-environment)
- [Config variables](#config-variables)

# Run & Deploy

## Run in Cloudflare Workers environment

Fork and connect this project to Cloudflare Workers and configure it as below:

Variables and Secrets (runtime):

- `PROXY_URL` : Set to your worker domain origin, with optional path prefix.
E.g. `https://siteproxy.user.workers.dev` or `https://siteproxy.user.workers.dev/proxy/` .
- (optional) `HIDE_TOP` : Set to `1` to hide page top bar.

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

1. (optional) Set the `PORT` env to listening port, default is `5006`.
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

# Config variables

The following config variables are available. Use environment variables (node.js env)
or (runtime) variables (Cloudflare Workers env) to configure them.

- `PROXY_URL` : Set to server public http url origin, optionally with path prefix.
  - E.g. `https://siteproxy.workers.dev` or `https://siteproxy.workers.dev/proxy/` .
  - If not set, it defaults to `http://localhost:<PORT>`, which only works in local environment.
  - In non-localhost origin service worker requires `https`. You need a https enabled reverse proxy (like nginx or Cloudflare CDN) in node.js env.
- (Optional) `HIDE_TOP` : Set to `1` to hide the top bar in proxified website page.
- (Optional) `SCRIPT` : The custom JavaScript file url to inject to proxified website page.
Use `{{domain}}` as placeholder of current website domain. E.g. `https://example.com/{{domain}}.js` .
- (Optional) `SCRIPT_DOMAINS` : Comma-separated domain list. If set,
only inject `SCRIPT` if website domain is or ends with any domain of the list.
- (Optional) `DEBUG` : Flag to enable debug logging to stdout. Set to `1` or `*` to log all;
Set to comma-separated keyword list to log only if current website url contains any keyword in list.
- (Optional) `PORT` : Valid in node.js env only. Http server listen port. Defaults to `5006`.
- (Optional) `ADDR` : Valid in node.js env only. Http server listen addr. Defaults to `0.0.0.0`.

There are also few build time variables:

- (optional) `SITENAME` : Defaults to `Siteproxy`.
