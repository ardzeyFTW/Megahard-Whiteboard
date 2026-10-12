# Viewer boards, editor limit and shared-board fixes

Status: built 2026-10-12 (all three phases). Not yet deployed: the Worker must go out before the app. Builds on [collaboration-plan.md](collaboration-plan.md).

## Goal

1. Fix two problems found after launch: dead links, and jittery cursors.
2. Let the owner cap how many people can edit. Everyone over the cap joins as a viewer.
3. Give every viewer their own board next to the shared one, so a class can follow a lecture and write along, and copy things (a question, a diagram) across.

## Decisions (made 2026-10-12)

| # | Decision |
|---|---|
| 1 | A viewer's own board is **saved to their boards** like any other, and reopens when they use the same link again. |
| 2 | Viewers can **always copy** from the shared board. No owner switch. (Screenshots can't be blocked anyway.) |
| 3 | A viewer bumped by a full room gets an editing spot only by **reopening the link** after one frees up. No promote button, no queue. |
| 4 | Room size has **separate caps**: editors (set by the owner, up to 10) and **10 viewers** for now. The viewer cap is one constant; a local 40-viewer test shows what raising it would cost. |
| 11 | Viewers **can't keep the shared board**. They keep their own side board, which is either a board they opened from their list or a new one. Anything they copy into it is theirs. |
| 12 | Editing shortcuts (undo, redo, paste, tool keys, delete) **only ever act on the viewer's own board**. |

Defaults chosen without asking. Change any of them before Phase B starts:

| # | Default |
|---|---|
| 5 | The editor limit **includes the owner**. Range 1-10, default 10. This matches the 10 cursor colours. |
| 6 | An editor who drops off (wifi blip, laptop sleep) keeps their spot for **2 minutes**, so a newcomer can't take it. |
| 7 | Viewers **don't show a cursor, selection or tool** to others. They appear in the people list by name. This keeps a crowd of viewers cheap. |
| 8 | A viewer's board is only created in their list **after their first mark**, so opening a link and leaving doesn't clutter their 50 boards. |
| 9 | A board the viewer is themself sharing can't be used as their notes board. |
| 10 | Split layout is side by side on wide screens and stacked on tall ones. Phones get a **Lecture / My board** switcher instead. |

---

## Phase A: the two fixes

### A1. Dead link goes home
Today a closed, stopped or missing room shows a one-button popup ([collab.ts:398-416](../src/ui/collab.ts#L398-L416)). Closing it any other way (X, Esc, click outside) leaves the guest on an empty read-only board, and its button adds a history entry that makes Back reopen the dead link.
- Closing the popup **any way** sends the guest to `#/` using `history.replaceState`, so Back doesn't return to the dead link.
- The guest's cached copy is already deleted for these cases. Keep that.
- Same handling for `bad_secret` and `full`. (`full` changes in Phase B.)
- Test by hand: close a room (short grace timer), then open its link with Esc, X and the button.

### A2. Smooth cursors
Cause (from reading the code): cursor updates arrive about every 100 ms and the shown cursor chases the newest one with an easing curve ([editor.ts:565-587](../src/editor/editor.ts#L565-L587)). Speed changes sharply on every update, which reads as small hops.
- The sender keeps its recent pointer positions and sends **up to 8 recent points with time offsets** in each update. Same number of messages as today.
- The receiver stores these in a buffer and **plays them back about 150 ms behind real time**, interpolating between points. If the buffer runs dry the cursor holds still; it never guesses ahead.
- The playback code is a small standalone module (`src/sync/cursorTrack.ts`) with unit tests: out-of-order arrival, a long gap, a cursor that leaves and returns.
- Measure first: a dev-only recorder logs the displayed cursor position every frame, and I compare speed variation before and after.
- Cost: cursors show about 0.15 s late. Accepted.
- Later, if dragged elements still look steppy, the same method applies to them.

## Phase B: editor limit

**Server** ([room.ts](../server/src/room.ts), [protocol.ts](../src/sync/protocol.ts))
- Room setting `editorLimit` (1-10, default 10), counting the owner.
- In `onHello`, an edit-link joiner who finds every spot taken is **admitted as a viewer**. The welcome message carries `downgraded: true`.
- Spot count = connected owner and editors, plus editors who left in the last 2 minutes. The client sends a random per-tab seat id so the same person gets their spot back. Held spots are kept in memory only, which is fine if the room hibernates.
- The owner changes the limit while live with a new control message. Lowering it never removes anyone already editing.
- `MAX_PEOPLE` splits into `MAX_EDITORS` (10) and `MAX_VIEWERS` (10). `full` now means the viewer cap is also reached.

**App**
- Share dialog: "People who can edit" stepper (includes you), plus a line showing "7 of 10 spots used".
- Downgraded joiner: popup "The editing spots are full (10 of 10). You joined as a viewer. Open this link again later if a spot frees up." The banner says "View only".
- If a downgraded person's connection later reconnects and a spot is free, they become an editor and see a short toast.

**Tests** (extend [room.test.ts](../server/test/room.test.ts)): limit enforced, downgrade message, seat held for 2 minutes and then released, limit lowered below the current count, viewer cap, owner always admitted.

**Deploy:** the Worker must go out before the app, since the app expects the new messages. I'll ask before deploying.

## Phase C: the viewer's own board

### C1. Make two editors coexist
Every editor listens to the whole window for keys and the whole document for copy, cut and paste ([editor.ts:316-330](../src/editor/editor.ts#L316-L330)). With two on one page, Ctrl+Z or Ctrl+C would act in both.
- Per decision 12, the **notes editor owns the keyboard**: undo, redo, paste, tool keys, delete and nudge always go to it.
- The shared pane only reacts to pan and zoom keys, and to Ctrl+C / Ctrl+A when the viewer last clicked on it (copy needs to read from that pane).
- Add an `Editor` option for this, so a normal board behaves exactly as today.
- The shared pane never writes pen, colour or shortcut settings to saved preferences.

### C2. Select and copy without editing
View-only mode currently only pans ([editor.ts:1244](../src/editor/editor.ts#L1244), [editor.ts:1723](../src/editor/editor.ts#L1723)). Add a **look-and-copy** mode for the shared pane:
- Click, marquee and Ctrl+A select; move, delete, edit, cut, paste and nudge stay blocked.
- Ctrl+C works. The selection isn't sent to anyone (decision 7).
- Pan and zoom work as today.

### C3. Layout
- [boardView.ts](../src/ui/boardView.ts) builds all toolbars around one editor. Pull that into a function that builds the tools for a given editor inside a given pane.
- Normal boards call it once, as today. Viewers call it for the notes pane, and get a small shell for the shared pane: zoom, fit, people, status banner, **Copy to my board**.
- Draggable divider; double-click resets it to half. The split direction and divider position are saved in preferences ([prefs.ts](../src/prefs.ts)).
- Settings gets a "Layout when viewing: Side by side / Top and bottom" option. Viewers also get a quick toggle in the top bar.
- Narrow screens: one pane at a time with a switcher.

### C4. The notes board
- A normal local board, never networked.
- On joining as a viewer the notes pane offers **New board** (the default; starts working straight away) or **Open one of my boards**.
- It is saved to the boards list after the first mark (decision 8), named "Notes: <shared board name>".
- The link between room and notes board is stored with the guest cache in IndexedDB ([db.ts](../src/db.ts)). No database upgrade is needed, because only the stored value grows a field.
- If the room closes, the shared cache is deleted as today. The notes board stays.
- Edge cases: at the 50-board limit, the existing "board full" dialog appears. A board already open in another tab is last-write-wins, as now.

### C5. Copying across
1. **Ctrl+C in the shared pane, Ctrl+V in the notes pane.** The clipboard format, new ids, validation and size limits already exist ([editor.ts:1832-1876](../src/editor/editor.ts#L1832-L1876)).
2. **Copy to my board** button in the selection bar. Works on touch and without clipboard permission. Drops the items at the middle of the notes view.
3. Images come with their image data; the notes board's size limit applies.
4. **Later, if wanted:** drag a selection from one pane into the other.

### C6. Viewer presence and room cost
- Viewers send their name and role once and nothing else. The server throttles any further viewer presence to 1 update per 5 seconds, so a modified client can't flood a room.
- Everyone is still asked to resend their presence when someone joins (so the newcomer sees every name). With 10 viewers that is a small burst; a larger cap might want a change here.
- The cap ships at 10. A local test with 40 simulated viewers (join storm, owner drawing, viewer reconnects) records message counts and room memory, and the numbers go against the free-plan figures in section 9 of the collaboration plan.

### C7. Wording and docs
- Section 12, decision 1 of [collaboration-plan.md](collaboration-plan.md) ("guests can't save a copy") stays true for the shared board itself (no Save, no Export). Add that viewers keep their own side board, including whatever they copy into it.
- Share dialog: add a line that viewers can copy from the board.
- About dialog, README and landing page: mention viewers' own boards.

### Tests
- Unit: look-and-copy mode can't change the board; copy then paste between two editors keeps images and gives new ids; seat and limit logic.
- Browser, three windows (owner, editor, viewer) using the dev-only `window.__editor` handle: split on a wide and a narrow window, keys only reach the active pane, copying an image to the notes board, closing and reopening the link.

## Order and risk

A, then B, then C. Each ends in a working app.

The main risk is C1: `editor.ts` assumes it is the only editor on the page. The active-pane rule is small, but it touches every global listener, so it comes first in Phase C with its own tests before any layout work.

## Not included (say if you want any of these)
- Following the owner's view automatically.
- Removing a person or promoting a viewer by hand.
- Copying a screenshot region as a picture.
- An owner switch to turn viewer copying off.

## What was built and how it was checked (2026-10-12)

**Phase A**
- Dead link: closing the popup any way goes home without a history entry. Checked in a browser: Esc on a stopped room, and the X when opening a dead link fresh.
- Cursors: recent positions are sent and replayed 150 ms behind. With a cursor moving at constant speed and updates arriving 20-90 ms late, speed variation fell from about 0.4 to 0.02 (virtual clock, since a hidden browser tab doesn't run animation frames). Also checked end to end through the local server. Unit tests in `cursorTrack.test.ts`.

**Phase B**
- Server: seats (the owner always keeps one), downgrade to viewer, 2-minute seat hold, owner-set limit that never removes anyone, viewer cap of 10, viewers' cursors dropped, flood limit. Five new end-to-end tests in `room.test.ts` (27 in all).
- App: stepper in the Share dialog, popup and banner for a downgraded person, toast if a spot opens up. Checked in a browser, including a real server restart after which a downgraded viewer got a spot, the split closed and editing worked and reached the owner.

**Phase C**
- Editor: look-and-copy mode, `acceptKey` / `acceptClipboard` routing, `shouldSave` so an untouched new board is never saved. Routing rules unit-tested in `paneRouting.test.ts`.
- `editorTools.ts` (the drawing tools, now built once per editor) and `viewerBoard.ts` (split, divider, tabs on narrow screens, notes board, board picker, copy). An ordinary board was re-checked after the move: drawing, selecting, duplicate, undo, zoom, tool keys, popovers.
- Checked in a browser as a viewer: split side by side and stacked, divider (mouse, double-click, keys) and Settings option, saved preferences, select by click and box, Copy to my board, Ctrl+A / Ctrl+C / Ctrl+V through real clipboard events, undo and tool keys reaching only the own board, Delete not touching the shared board, drawing, saving as "Notes: <board name>", reopening the same board when the link is opened again, no empty board added by a blank start, switching boards, boards being shared by the viewer not offered, phone-width tabs (a 560 px frame), image copied with its data.
- Not checked on a real phone or touch screen, and drag-across between the panes was not built.

**40 viewers** (`server/test/load.test.ts`, run with `LOAD=1 npm test -- load` from `server/`): owner, 3 editors and 40 viewers joined in about 1 s and every viewer got every stroke; the 41st was refused. With the owner and 3 editors moving cursors nonstop and drawing, the server received about 41 messages a second. At 20 incoming messages per request that is about 7,400 requests an hour, so roughly 13 hours a day of nonstop lecture on the free plan. Outgoing traffic was about 170 KB/s. The cap stays at 10 (`MAX_VIEWERS` in [protocol.ts](../src/sync/protocol.ts), and a server setting).
