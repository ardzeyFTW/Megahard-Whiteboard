# Live collaboration plan

Status: launched 2026-10-12. All phases done. Last updated 2026-10-11.

## Goal

Several people can draw on the same board at the same time. Boards still live on the owner's device. The server keeps a shared board only while it is being shared, plus a short pickup window, then deletes it. Nobody gets permanent cloud storage, so storage costs stay close to zero.

### Ground rules
- **Local-first stays.** Boards that are never shared never touch the network, as today.
- **The host owns the board.** Guests work on the host's board through the server. Only the host's device keeps it for good.
- **No accounts.** Sharing works through secret links. The host's device keeps a private host key.
- **Free plan only.** Nothing in this plan needs a paid Cloudflare plan or a card on file. If a free limit is hit, sharing stops working until the daily reset. You never get a surprise bill.

---

## 1. How it works for people

**Host shares a board**
1. The host opens a board and clicks **Share**.
2. The app creates a room on the server and uploads the board and its images.
3. The Share dialog shows an **edit link** and a **view-only link**, each with a Copy button, plus a short note on what happens to the data.
4. A "Sharing · 3 people here" pill appears in the top bar. Clicking it opens the dialog again (links, people list, **Stop sharing**).

**Guests join**
1. A guest opens the link and must enter a display name before joining. The box suggests a random animal name (like "Blue Otter") that they can accept with one click. The name is remembered for next time.
2. The room gives each person, host included, their own colour from a 10-colour palette, so no two people in a room share a colour.
3. They see the board live, with everyone's cursors and names, and can draw if they have an edit link. View-only guests can look, pan and zoom, and their cursor still shows to others.
4. The board isn't added to the guest's own board list. It stays in a temporary cache so a page reload is instant. Guests don't get "Save board file" or "Export as image". (Screenshots and copy/paste can't be blocked, but the app doesn't offer saving.)

**Host leaves (closes the tab, loses wifi, or the laptop sleeps)**
1. Guests see a banner: "Alex left. This board stays open for 59 min." The countdown updates every minute.
2. Guests can keep editing. The server keeps saving.
3. If the host comes back within the hour, the banner disappears and everything carries on.

**The hour runs out**
1. Guests are disconnected and see "This shared board has closed." Their temporary cache is deleted. Only the host keeps the board.
2. The server keeps the final version, read-only, for **7 days** so the host can collect it.

**Host comes back later**
1. When the app opens, it checks each board the host shared. Any board with changes still on the server is downloaded, merged with the local copy and saved, even if the host doesn't open that board.
2. Once the host's device confirms it has everything, including images, the server deletes the room.
3. Edits the host made offline in the meantime are merged too. Nothing is overwritten (see section 4).

**Host clicks Stop sharing**
Guests are disconnected right away. Sharing again later always makes a **new link**, so old links never reopen the board. The host already has the latest version, so the server deletes the room immediately.

**Host deletes a shared board**
A confirmation explains that sharing will end too. The server room is deleted.

---

## 2. Architecture

```
 Host browser                      Cloudflare (free plan)                Guest browsers
 ┌──────────────────┐             ┌──────────────────────────────┐      ┌──────────────┐
 │ Editor           │             │ Worker  (HTTP router)        │      │ Editor       │
 │   ↕ adapter      │  WebSocket  │   POST /rooms  (create)      │  WS  │   ↕ adapter  │
 │ Yjs doc  ────────┼────────────►│   GET/PUT /rooms/:id/assets  │◄─────┼─ Yjs doc     │
 │   ↕              │             │   /rooms/:id/ws → Room       │      │   ↕          │
 │ IndexedDB        │   HTTPS     │                              │      │ temp cache   │
 │ (board, images,  │────────────►│ Room = 1 Durable Object      │      └──────────────┘
 │  share key, Yjs  │             │  · live Yjs doc in memory    │
 │  state)          │             │  · SQLite: doc + images      │
 └──────────────────┘             │  · alarms: 1 h / 7 day timers│
                                  └──────────────────────────────┘
 Website: GitHub Pages (unchanged)
```

- **Website:** stays on GitHub Pages. The server address is set at build time with `VITE_COLLAB_URL`. If it isn't set, the Share button is hidden.
- **Worker:** a small HTTP router. It creates rooms, enforces CORS (only the GitHub Pages site and localhost), applies rate limits, and forwards each request to the right room.
- **Room (Durable Object):** one per shared board. It holds the live Yjs doc, saves to its own SQLite storage, stores images, and uses alarms for the timers. It's a small custom server ([server/src/room.ts](../server/src/room.ts)) speaking the standard y-protocols sync and presence messages. We chose that over y-partyserver because the host rules, view-only links, sign-in by message and hibernation were all simpler to get right directly.
- **Merging:** **Yjs**, a library that lets several people edit the same data and merges the changes automatically. Every board uses it, shared or not (section 4).

### Why not Supabase or another database
A room needs live state in memory, its own storage and timers. A Durable Object does all three in one place. Supabase would need Realtime, Postgres, Storage and scheduled cleanup jobs wired together, and free Supabase projects pause after a week of no use.

---

## 3. Room lifecycle on the server

| State | Meaning | Who can connect | Timer |
|---|---|---|---|
| `live` | Host connected | Host, editors, viewers | none |
| `grace` | Host disconnected | Host, editors, viewers | alarm at host-left + **60 min** → `closed` |
| `closed` | Grace ran out | Host only (to collect) | alarm at closed + **7 days** → `deleted` |
| `deleted` | All data removed | nobody (404) | n/a |

Transitions:
- Host socket closes and no other host socket is open → `grace`, alarm set.
- Host reconnects during `grace` → `live`, alarm cancelled.
- Alarm in `grace` → `closed`. Guests are sent a "closed" message and their sockets close with code `4001`.
- Host sends `collected` after saving (doc and every image) → `deleted` right away.
- Host sends `stop` → guests are disconnected → `deleted`.
- Alarm in `closed` → `deleted`.

The room stores: `state`, `hostLeftAt`, hashed secrets, `bytesUsed`, the Yjs doc and image chunks.

---

## 4. Data model and merging

### Shared Yjs document
```
ydoc
├─ elements : Y.Map<elementId, ElementJSON & { z: string }>
├─ assets   : Y.Map<assetId, { mime: string, bytes: number }>   // metadata only
└─ meta     : Y.Map  { name: string, background: Background }
```
- **Each element is a plain JSON value.** Elements are already immutable with stable ids. Changing an element replaces its value, so two people editing the same element means the last change wins. That's fine for strokes and shapes. For notes and text, concurrent typing is prevented with a soft "Alex is editing" lock (section 6).
- **Paint order** uses a fractional index `z` (a string that sorts between its neighbours, from the `fractional-indexing` package). That way "bring to front" from two people at once can't corrupt the order. The editor's `doc.elements` array is built by sorting on `z`.
- **The camera isn't shared.** Everyone keeps their own view.
- **Image bytes aren't stored in the Yjs doc.** They go over HTTP (section 7), which keeps the doc small and syncing fast.

### Why every board uses Yjs, shared or not
The "host comes back and merges" step only works if the host's device keeps the Yjs history for that board. If we rebuilt a Yjs doc from plain elements on every load, an element a guest deleted would come back when the host merged. Using Yjs everywhere also gives one undo system to test instead of two.

### Local storage (IndexedDB version 1 → 2)
- `boards` / `meta`: unchanged. The packed `BoardDoc` stays the main save. Thumbnails, export, backup and import all work as today, and old backups still import.
- New store `ystate`: board id → Yjs state (bytes). Written only for boards that have been shared. A board that was never shared builds a fresh Yjs doc from its elements on load, which is safe because nothing else has a copy of it.
- New store `shares`: board id → `{ roomId, hostKey, editSecret, viewSecret, server, createdAt }`.
- New store `guestSessions`: room id → cached Yjs state + name. Removed when the room closes, or after 7 days.
- `.mhwb` exports and "Back up all" **never** include `shares` or `ystate`. Duplicating a board doesn't copy them.

---

## 5. Client changes

### 5.1 Editor ↔ Yjs adapter (`src/sync/boardSync.ts`, new)
- **One write path.** Today the editor assigns `this.doc.elements = ...` in about 15 places. Replace all of them with one `setElements(next)` method.
- **Local changes.** `setElements` compares old and new arrays by reference (elements are immutable, so this is cheap) and writes only the changed, added and removed ids to Yjs in one transaction, tagged as `local`.
- **Remote changes.** A Yjs observer rebuilds `doc.elements` from the changed ids. It reuses unchanged element objects so render caches stay valid, drops removed ids from the selection, and cancels a text edit if someone else deletes that element.
- **Validation.** Every element that comes from another person goes through `sanitizeElement` / `sanitizeAssets` (already in `model.ts`). Invalid elements are skipped and never rewritten, so two clients can't end up correcting each other in a loop.

### 5.2 Undo/redo
- Replace `History` ([history.ts](../src/editor/history.ts)) with **Y.UndoManager**, which only tracks local changes. Undo then undoes your own strokes, never a guest's.
- Map the existing `checkpoint()` calls to `undoManager.stopCapturing()`, with a very long capture timeout. One gesture (a drag, a resize) stays one undo step, as today.
- `discardIfUnchanged` is no longer needed, because Yjs makes no undo step when nothing changed.

### 5.3 Live gestures
- **Moving and resizing** write to Yjs at most once per animation frame, so others see the motion live.
- **A stroke in progress** is sent through *presence* (5.4), not the doc. The doc gets one change per finished stroke, which keeps traffic and storage down.

### 5.4 Presence (Yjs awareness)
Each person broadcasts `{ name, color, cursor (world coords), tool, selection ids, editing id, live stroke points }`, sent at most 10 times a second and only while something changes.
- **Colour** is assigned by the room when someone joins: the first free colour from a fixed 10-colour palette, so colours never clash.
- **Rendering:** other people's cursors with name tags, a thin outline in their colour around what they've selected, and their in-progress stroke drawn faintly.
- **People list** in the Share dialog. Clicking a person jumps your view to their cursor.

### 5.5 UI
- **Board top bar:** a **Share** button, which becomes the "Sharing · N" pill while sharing.
- **Share dialog:** edit link, view-only link, people list, Stop sharing, and the privacy note.
- **Join route:** `#/join/<roomId>/<secret>`. The secret is after `#`, so it's never sent to GitHub Pages.
- **Banners:** host left (countdown), reconnecting, closed, view only.
- **Home screen:** a "Shared" badge on boards being shared. When the app opens, it collects any closed rooms in the background.
- **Copy updates:** the About dialog, README and `package.json` currently say nothing ever leaves the device. Change them to: "...unless you share a board. Shared boards stay on our server only while shared, and are deleted at most 7 days after."

---

## 6. Conflicts and edge cases

| Case | Behaviour |
|---|---|
| Two people move the same shape | Last change wins. Both see the same result within a moment. |
| Two people type in the same note | Prevented: while someone edits a note, others see "Sam is typing" and can't open it until Sam finishes or leaves. |
| Someone deletes an element you have selected | It disappears from your selection. If you were typing in it, your edit ends. |
| You undo after a guest changed the same element | Yjs restores your previous version of it, and the guest's later change to that element is replaced. Normal for whiteboards. |
| Host edits offline while guests edit online | Both sets of changes merge when the host reconnects or collects. |
| Host opens the board in two tabs | Both count as the host. Grace starts only when the last host tab closes. |
| Connection drops | Edits keep working locally and sync on reconnect (Yjs handles this). A "Reconnecting…" banner shows. |
| A guest reloads after the room closed | "This shared board has closed." The cache is cleared. |
| An 11th person opens the link | "This board is full (10 people)." They can try again later. |
| A room reaches the size limit | New images are refused with a toast. Drawing still works. |

---

## 7. Server details

### HTTP API (Worker)
| Method & path | Auth | Purpose |
|---|---|---|
| `POST /rooms` | rate limit per IP (10/hour) | Create a room. Returns `roomId`, `hostKey`, `editSecret`, `viewSecret`. |
| `GET /rooms/:id/ws` | secret sent in the first message | WebSocket upgrade into the room. |
| `GET /rooms/:id/status` | host key | `{ state, closesIn }` for the home screen. |
| `GET /rooms/:id/assets` | any secret | List of stored asset ids, so the host uploads only what's missing. |
| `PUT /rooms/:id/assets/:assetId` | host or edit secret | Upload one image (≤ 10 MB, image types only). |
| `GET /rooms/:id/assets/:assetId` | any secret | Download one image. |
| `DELETE /rooms/:id?reason=stopped\|collected` | host key | Stop sharing, or delete the room after collecting. |

Secrets go in an `Authorization` header (or the first WebSocket message), never in the URL. That keeps them out of logs.

### Storage inside a room (SQLite)
- `doc` table: Yjs updates are buffered and written at most every 2 s, then compacted into one snapshot on every state change. This matters because the free plan allows 100,000 row writes per day.
- `assets` table: image bytes split into ≤ 1 MB chunks (a single SQLite row maxes out at 2 MB).
- **Limits per room:** 50 MB total (same as the per-board limit in [limits.ts](../src/limits.ts)) and 10 people at once.

### Hibernation
The room uses Cloudflare's WebSocket Hibernation API, so a room with connected but idle people isn't charged for duration. Nothing important is kept only in memory: the document reloads from SQLite on the first message after a wake-up (tested by restarting the local server mid-test), and each socket's role, colour and presence ids are kept in its hibernation-safe attachment. Edits are saved in 2-second batches; a pending save timer keeps the room awake until it's written.

---

## 8. Security and privacy

- **Secrets:** room id, host key and both link secrets are random 128-bit values. The server stores only their SHA-256 hashes.
- **View-only enforcement:** the server drops document updates from view-only sockets; it doesn't trust the client.
- **Untrusted data:** everything arriving from a room is validated with the existing `sanitize*` functions before it's rendered or saved. Images are accepted only if they match the same `SAFE_IMAGE` data-URL pattern used for imports.
- **CORS:** only `https://ardzeyftw.github.io` and `http://localhost:4173`.
- **Abuse:** room creation is rate limited per IP, and there are size, people and lifetime caps. Rooms always expire, so storage can't pile up.
- **Not end-to-end encrypted.** The server can read shared boards while they exist. The Share dialog says so plainly. Possible later upgrade: encrypt with a key kept in the link's `#` part.
- **The service worker** ([public/sw.js](../public/sw.js)) must never cache requests to the collaboration server.

---

## 9. Free-plan budget

From Cloudflare's [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) and [limits](https://developers.cloudflare.com/durable-objects/platform/limits/) pages. Free limits reset daily at 00:00 UTC.

| Limit (free) | What uses it | Rough capacity |
|---|---|---|
| 100,000 requests/day; incoming WebSocket messages count 20:1 | connections, edits, cursor moves | about 2 million incoming messages/day. Cursor updates are capped at 10/s per person. |
| 13,000 GB-s duration/day | time a room is awake | about 29 room-hours awake per day. Hibernation makes idle time free. |
| 100,000 SQLite row writes/day | saving | a 2 s save buffer gives roughly 50+ hours of active editing per day |
| 5 GB SQLite storage total | rooms + images | 100 full 50 MB rooms at once. Most boards are far smaller, and rooms expire. |

If a limit is hit, only that kind of operation fails until the reset. The app shows "Sharing is busy right now, try again later" and the local board keeps working. If the app outgrows this, the Workers Paid plan is $5/month.

---

## 10. Phases

Each phase ends in a working, shippable state.

### Phase 0: groundwork
- [x] Add `vitest` for unit tests.
- [x] Add `yjs` and `fractional-indexing`. (`y-protocols` comes in Phase 2 with the network code.)
- [x] Decide the open questions in section 12.

**Done when:** tests run with `npm test`.

### Phase 1: Yjs inside the app, still local only
- [x] Route every elements change through `setElements`.
- [x] Add the `boardSync` adapter (local ↔ Yjs ↔ `doc.elements`) and `z` ordering ([boardSync.ts](../src/sync/boardSync.ts)).
- [x] Replace `History` with `Y.UndoManager`.
- [x] Tests ([boardSync.test.ts](../src/sync/boardSync.test.ts)): local edits → Yjs → back give identical boards; undo/redo match today's behaviour; merging two diverged docs; the "deleted element doesn't come back" case; invalid data from others is skipped.
- Moved to Phase 3: the IndexedDB version 2 bump (`ystate`, `shares`, `guestSessions` stores), since nothing uses them until sharing exists.

**Done when:** solo use feels exactly the same as today, including undo, copy/paste, and import/export of old boards.

### Phase 2: room server, run locally
- [x] `server/` folder: Worker + Room Durable Object (custom, y-protocols), `wrangler.jsonc`.
- [x] `POST /rooms`, hashed secrets, sign-in in the first message, view-only enforcement, 10-person limit with a different colour each.
- [x] SQLite saves with a buffer, 1 MB parts and compaction.
- [x] Reloading after a wake-up (tested with a server restart). True hibernation can't be forced locally; check it once deployed.
- [x] App side: [connection.ts](../src/sync/connection.ts) (sync, presence, reconnect with backoff, no retry on bad links).
- [x] `npm run dev:server` runs it with `wrangler dev`, and `npm run test:server` runs 9 end-to-end tests against a real local server. No Cloudflare account needed.
- [x] [Self-hosting guide](self-hosting.md) for people running their own copy.

**Done when:** the app's sync code, run as several people, syncs a board through the local server. *(Done in the end-to-end tests. Two real browser windows come in Phase 3, since there's no Share button until then.)*

### Phase 3: sharing UI
- [x] IndexedDB version 2 (`ystate`, `shares`, `guests` stores).
- [x] Share button, Share dialog, `#/join` route, guest name prompt (required, with an animal-name suggestion).
- [x] Guest temporary cache, view-only mode, Reconnecting and "owner has left" banners, "Shared" tag on the home screen.
- Moved to Phase 7: the privacy wording in the About dialog, README, package.json and landing page. It stays accurate until sharing goes live.

**Done when:** a host shares a link and a guest edits live, all on localhost. *(Tested in three real browser tabs: owner, editor and viewer.)*

### Phase 4: host lifecycle
- [x] Room states and alarms (60 min grace, 7 day pickup). A room that's never joined by its host still closes; a live room re-checks every hour that its host is really there, so a server restart can't leave it open forever.
- [x] Host-left banner with a countdown, "Sharing has ended" screens for closed and stopped rooms (guest cache cleared).
- [x] Collect on board open and in the background on the home screen. The server copy is deleted only after the save succeeds.
- [x] Stop sharing, plus deleting a shared board. Host-only `GET /rooms/:id/status` and `DELETE /rooms/:id`.
- [x] Tests: 6 lifecycle end-to-end tests with short timers (closing, coming back in time, stopping, pickup expiry, restart while connected, host-key-only). Browser-tested with a 20 s window.
- Found while testing: on Windows, stopping `wrangler dev` can leave its `workerd` process holding the port. The test script now also stops whatever listens on its port.

**Done when:** every scenario in section 1 works on localhost (with shortened timers for testing).

### Phase 5: images
- [x] Upload missing images when sharing starts (before the links are shown), on every reconnect, and when anyone adds one (before it appears for others).
- [x] Download on join (retrying images still being uploaded) and during collection; the room is only deleted once every image is home. Stored in 1 MB parts.
- [x] Images can't be replaced once stored; only real image types are accepted (checked by their first bytes); downloads can never run as a page. Room size limit (50 MB) and its toast.
- [x] Tests: 6 image end-to-end tests. Browser-tested: owner's image to guest, guest's image to owner, and a guest's image added while the owner was away, collected from the home screen.
- Found while testing, and fixed for everyone: in a background tab the browser never finishes decoding images, so on a board with images, saving got stuck at the thumbnail step (including the save made when switching tabs). Present since the first release.

**Done when:** images work in every section 1 scenario, including images a guest added that the host collects later.

### Phase 6: presence
- [x] Cursors with name tags, selection outlines, strokes drawn live, people list (redrawn only when people change), click a person to go to them.
- [x] Note and text editing locks: "Sam is typing" on the note; others get "Sam is editing this right now". Text typed shows up live.
- [x] Everything received is checked (numbers, colours, sizes, list lengths). Presence is sent at most 10 times a second, and only when it changed.
- Browser-tested with canvas snapshots (a dev-only `window.__editor` handle, stripped from the published build).
- Not done: the 30 s lock timeout. A lock lasts while the person has the note open, and goes when they leave.

**Done when:** you can see what everyone is doing in real time.

### Phase 7: harden and launch
- [x] Rate limits (10 new shared boards per hour per network, counted in memory by a small `Limiter` Durable Object), people cap, message size cap, friendly errors when sharing can't start.
- [x] Update the privacy wording (About dialog, README, package.json, landing page) now that boards can be shared.
- [x] The Pages workflow passes the `VITE_COLLAB_URL` repository variable to the build.
- [x] Deployed the Worker and set the `VITE_COLLAB_URL` repository variable. Checked on the live site: share, join, edits both ways, stop sharing. (That shared server has since been retired: everyone who shares now uses their own, see `docs/self-hosting.md`.)
- Found at launch: opening the new version while an older one was open elsewhere left the home screen waiting (the old tab holds the database during the one-time upgrade to version 2). It now says to close the other tab; future upgrades don't need this.
- [ ] Optional: GitHub Action that deploys the Worker when `server/` changes.
- [ ] Manual test pass on phone, tablet and desktop, across two networks (for the owner to do with a friend).

**Done when:** sharing works on the live GitHub Pages site.

---

## 11. Cloudflare setup: who does what

**You (one time, about 5 minutes):**
1. Create a free account at [dash.cloudflare.com](https://dash.cloudflare.com/sign-up). No card needed: this plan avoids R2 and every other paid feature.
2. In the project folder, run `npx wrangler login`. A browser window opens. Sign in and click **Allow**.
3. In the dashboard under **Workers & Pages**, pick your `workers.dev` subdomain (for example `ardzey`). The server will then live at `megahard-collab.ardzey.workers.dev`.
4. *Optional, for automatic deploys:* create an API token from the **Edit Cloudflare Workers** template and add it to the GitHub repo as the secret `CLOUDFLARE_API_TOKEN`, with your account id as `CLOUDFLARE_ACCOUNT_ID`.

**Me:**
- All code: server, `wrangler.jsonc`, client, tests.
- Everything up to Phase 6 runs locally with `wrangler dev`, so none of it needs your account.
- Deploy the Worker with `wrangler deploy` once you're logged in. I'll ask before each deploy, since it goes live.
- Set `VITE_COLLAB_URL` as a GitHub repo variable and update the Pages workflow (I'll ask first).

---

## 12. Decisions (made 2026-10-11)

1. Guests **can't** save a copy of the shared board. When a room closes, only the host keeps the board. Guests get no Save board file or Export as image. *(Updated 2026-10-12: viewers get a board of their own beside the shared one, and can copy things from the shared board into it. See [viewer-board-plan.md](viewer-board-plan.md).)*
2. Sharing again after it ended makes a **new link** every time.
3. View-only links are in the first version.
4. Guests **must** enter a name to join. The box suggests a random animal name they can accept.
5. At most **10 people** per room, and each gets a **different colour**, assigned by the room. *(Updated 2026-10-12: up to 10 editors, the owner included, plus up to 10 viewers. Viewers show no cursor.)*
6. Pickup window: **7 days**.
7. Guests can add images, counting toward the 50 MB room limit. (Default; not discussed.)
8. Grace period after the host leaves: **60 minutes**.

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| Phase 1 touches undo and every edit path, so regressions are possible | Phase 1 ships alone with tests before any networking |
| Free daily limits run out on a busy day | Throttled cursors, buffered saves, hibernation, friendly error. $5 paid plan if needed. |
| Hibernation reload behaviour in y-partyserver is unclear | Phase 2 spike. Custom server as a fallback. |
| Host never comes back within 7 days | Background collection whenever the app opens. The pickup window is shown in the Share dialog. |
| Public endpoint gets abused | Rate limits, caps, short lifetimes. Hashed secrets. |
