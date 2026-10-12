# Setting up your own sharing server

## Who needs this?

**Anyone who wants to share a board.** Sharing runs on a small server that belongs to the person sharing, in their own free Cloudflare account. Nobody else's account is used, so there is no central server to pay for, to run out of free limits, or that holds other people's boards.

**The people you invite need nothing.** They open your link and join. The link says which server holds the board.

If you only draw on your own, you don't need any of this.

## What it costs

Nothing, on Cloudflare's free Workers plan, and no card is needed. The server stores a shared board only while it's being shared, plus up to 7 days for you to collect it, then deletes it. If your free daily limits run out, sharing from your server pauses until 00:00 UTC. You can't be billed on the free plan.

## Set it up (about 5 minutes, once)

### The easy way: from the app

1. Open a board and press **Share**. The first time, the dialog explains the setup.
2. If you don't have one, make a free [Cloudflare account](https://dash.cloudflare.com/sign-up).
3. Press **Deploy my server**. This opens Cloudflare's "Deploy to Cloudflare" page, which copies this project's [server](../server) into your account and publishes it. Follow the steps it shows.
4. Cloudflare gives you an address that ends in `workers.dev`, like `https://megahard-collab.yourname.workers.dev`. Paste it into the Share dialog and press **Save address**. The app checks that it can reach it.

That's it. Your address is saved in your browser. You can change it later from the Share dialog (**Change** next to "Sharing server").

### The command line way

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
cd server
npm install
npx wrangler login      # a browser window opens: sign in and click Allow
npx wrangler deploy     # prints your server's address
```

Your login is stored in your user folder, not in the project, so it can't end up in git. If you haven't chosen a workers.dev subdomain yet, Cloudflare dashboard → **Workers & Pages** lets you pick one.

Then paste the address into the Share dialog as above.

## Which websites can use your server

A server only accepts requests from the websites listed in `ALLOWED_ORIGINS` in [server/wrangler.jsonc](../server/wrangler.jsonc). It comes set to the official site (`https://ardzeyftw.github.io`) and to `localhost`, so a server deployed from this project works with the official site straight away.

If you run **your own copy of the app** (for example a fork published to your own GitHub Pages), add that address to `ALLOWED_ORIGINS` before you deploy, for example `https://yourname.github.io`. If the Share dialog says it can't reach a server you know is up, this is the usual cause: the browser hides the reason.

## Publishing a copy of the app with a server built in

Optional, for a fork whose users should not have to set anything up. Build with `VITE_COLLAB_URL` set to a server address. For the GitHub Pages workflow, add a variable named `VITE_COLLAB_URL` under your repository's **Settings → Secrets and variables → Actions → Variables**; the workflow passes it to the build. It's a plain variable, not a secret: the address ends up in the website for everyone to see anyway.

People can still choose their own server instead. The official site sets no such variable, so everyone who shares there uses their own server.

## Local development

No Cloudflare account is needed to work on sharing locally.

```bash
npm run dev:server     # the server at http://127.0.0.1:8787
npm run test:server    # end-to-end tests: starts its own server
```

To point a local build of the app at the local server, either paste `http://127.0.0.1:8787` into the Share dialog, or create `.env.local` in the project root containing `VITE_COLLAB_URL=http://127.0.0.1:8787`. Files starting with `.env` are git-ignored.

A classroom-size check is available too: `LOAD=1 npm test -- load` from the `server` folder runs a room with an owner, editors and 40 viewers and reports the traffic.

## Keeping secrets out of git

The server needs no passwords or API keys: each shared board gets its own random keys when it's created, and the server keeps only their hashes. Still, if you add anything private:

- Put local secrets in `server/.dev.vars`. It's git-ignored.
- For deploys from GitHub Actions, store a Cloudflare API token as a repository **secret** (`CLOUDFLARE_API_TOKEN`), never in a file.
- Your Cloudflare account id isn't needed in `wrangler.jsonc` when you deploy with `wrangler login`. Leave it out.

## Good to know

- **Shared boards aren't end-to-end encrypted.** Your server can read a board while it's shared. Since the server is yours, that is you.
- **Joining a link connects to the server named in it.** The app shows that server's name before someone joins. Only join links from people you trust, as with any link.
