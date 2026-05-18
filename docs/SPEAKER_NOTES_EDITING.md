# Speaker-notes editing & deck export

> Stage A.5 — owner-side editing of `manifest.slides[].notes` plus one-click
> `.stage` re-export. Designed to be the smallest possible extension that
> respects the spec's "deck is the source of truth" contract while shipping a
> good editor UX.
>
> See also: [`ARCHITECTURE.md`](./ARCHITECTURE.md) §4.5 (REST), §8.5 (data
> flow), §10 (tests), §11 (cookbook). This doc is the high-level summary; the
> architecture doc has the implementation map.

---

## 1. Goals

1. Let the deck **owner** rewrite any slide's speaker note from inside the
   web UI, with autosave.
2. Persist the edit so a refresh / new tab / mobile session sees the same
   text.
3. Let the owner download a fresh `.stage` package that carries the new
   notes — i.e. the package can be re-uploaded into a sister platform or
   handed to a colleague.

## 2. Non-goals

- Per-user "private notes" overlays. Notes are deck content; whoever owns
  the deck owns the notes.
- Version history. Edits overwrite in place. (See `ARCHITECTURE.md` §13
  — adding retention is a separate, Stage-B-shaped task.)
- Real-time multi-author collaboration on the same note.
- Editing slide HTML / titles. Out of scope; speaker-notes only.

## 3. Decisions taken

These were locked in at design time. If you need to revisit one, please
update both this section and the corresponding code paths.

| # | Decision | Rationale |
|---|---|---|
| 1 | Notes are deck content (overwrites `manifest.slides[].notes`). | Single-source-of-truth aligned with spec §9.1; consistent with PowerPoint's "save into deck" mental model. |
| 2 | Editor surfaces in the Speaker side panel (single window) **and** the Presenter view bottom strip. | Same `EditableNotes` component in two layouts — UX consistency, one code path to maintain. |
| 3 | Autosave: 800 ms debounce + slide-change flush + unmount flush. | Same pattern as `useStrokeSync`; keeps the network polite while never losing the latest keystroke. |
| 4 | Export = full `.stage` repack of the storage dir (not just `manifest.json`). | Keeps the export round-trippable (re-uploadable) and reuses the existing zip surface area. |
| 5 | **Lock-by-default Edit mode** with explicit `Edit ✎` / `Done` (or `Esc`) toggles. | Prevents the presenter who absent-mindedly clicks the notes panel from trapping ←/→/Space inside an active textarea. |
| 6 | Append-only audit log (`NoteEdit` table + `GET /notes/audit`). | Cheap to implement (single new table), zero overhead for non-changing PATCHes, and unblocks future "who/when" history UIs without back-filling data. |

## 4. Public surface

### 4.1 REST

| Method | Path | Body / Query | Response | Notes |
|---|---|---|---|---|
| `PATCH` | `/api/decks/:id/notes` | `{ notes: Record<"<1-based-idx>", string \| null> }` | `{ ok: true, updated: number, manifestUpdatedAt: string }` | Owner-only. Sparse — only sends changed slides. Empty string ⇒ clear (`null`). |
| `GET` | `/api/decks/:id/notes/audit` | — | `{ entries: NoteEditEntry[] }` | Owner-only. Newest-first. Capped to 200 entries. |
| `GET` | `/api/decks/:id/export` | — | `application/vnd.stage+zip` (binary stream) | `Content-Disposition: attachment; filename="<id>-<ts>.stage"`. Owner-only. |

Errors follow the existing `{ error: <code>, message: <string> }` shape.
Cross-user access returns 404 (not 403) to avoid id enumeration.

### 4.2 Shared schemas (`@slidestage/shared`)

```ts
// packages/shared/src/notes.ts
export const notesPatchBodySchema = z.object({
  notes: z.record(
    z.string().regex(/^\d+$/),  // 1-based slide index keys
    z.string().nullable(),       // empty string == "clear"
  ),
}).strict();

export type NotesPatchBody = z.infer<typeof notesPatchBodySchema>;
export interface NotesPatchResponse {
  ok: true;
  updated: number;
  manifestUpdatedAt: string;
}

export interface NoteEditEntry {
  id: number;
  deckId: string;
  userId: string;
  slideIdx: number;
  previousNotes: string | null;
  newNotes: string | null;
  editedAt: string;  // ISO timestamp
}
export interface NotesAuditResponse {
  entries: NoteEditEntry[];
}
```

### 4.3 Frontend client (`apps/web/src/api/client.ts`)

```ts
api.updateNotes(deckId, { '1': 'new text', '2': null });
api.exportDeck(deckId);   // triggers a browser download
```

## 5. Data flow

```
   ┌─────────────────────┐
   │   <textarea>        │
   │   EditableNotes     │
   └─────────┬───────────┘
             │ onChange
             ▼
   ┌─────────────────────┐    PATCH /api/decks/:id/notes
   │   useNotesSync      │ ──────────────────────────────▶  server
   │   debounce 800 ms   │
   │   slide-change flush│
   │   unmount flush     │
   └─────────┬───────────┘
             │ onPersisted(newNotes, updatedAt)
             ▼
   ┌─────────────────────┐
   │   page-side setDeck │   so the speaker panel / strip
   │   updates manifest  │   reflects the new note without
   │   mirror in place   │   a full deck reload
   └─────────────────────┘

   server PATCH route — ONE request fans out into FOUR sinks
   (atomic disk writes first, then a single Prisma transaction):

   ① Slide.notes (one row per slide)        ─┐
   ② Deck.manifest TEXT (full mirror)        │  Prisma
   ③ <storage>/<id>/manifest.json on disk    │  fs (tmp+rename)
   ④ <storage>/<id>/speaker-notes.json       ─┘  fs (tmp+rename)
   ⑤ NoteEdit (append one row per actually-changed slide) — Prisma

   GET /export — repack <storage>/<id> with adm-zip and stream the
   resulting buffer with the right Content-Type/Disposition.

   GET /notes/audit — newest-first paginated view of the NoteEdit
   table; consumed by future "Edit history" UIs.
```

## 6. Code map

Server:
- `apps/server/prisma/schema.prisma` — `NoteEdit` table (audit log).
- `apps/server/src/routes/notes.ts` — `PATCH /notes` handler (atomic
  writes + audit-row insert) and `GET /notes/audit` handler.
- `apps/server/src/routes/export.ts` — `GET /export` handler, recursive
  folder pack.
- `apps/server/src/server.ts` — registers all three routes; global error
  handler now also maps Zod errors to a 400 + `EBADMANIFEST`.

Web:
- `apps/web/src/hooks/useNotesSync.ts` — autosave hook (debounce + flush).
- `apps/web/src/components/EditableNotes.tsx` — controlled textarea +
  status pill (Editing / Saving / Saved / Failed); lock-by-default
  Edit-mode toggle (Edit ✎ / Done buttons + `Esc` exit).
- `apps/web/src/components/SpeakerNotes.tsx` — Speaker side panel;
  consumes `EditableNotes` in `panel` variant.
- `apps/web/src/pages/DeckViewerPage.tsx`,
  `apps/web/src/pages/PresenterViewPage.tsx` — mount `useNotesSync`,
  hold the page-level `notesEditing` boolean, pipe the api into the
  editor surface, and add the Export button.
- `apps/web/src/pages/DeckListPage.tsx` — per-deck Export button.
- `apps/web/src/api/client.ts` — `updateNotes()` + `exportDeck()`.

Shared:
- `packages/shared/src/notes.ts` — Zod body schema + types.
- `packages/shared/src/index.ts` — re-exports.

## 7. Tests

Server (vitest, `apps/server/tests/notes.test.ts`, 10 cases):
- PATCH propagates to all four sinks.
- Empty string clears the note.
- Out-of-range index → 400.
- Malformed body → 400 (verifies the global Zod-error mapping).
- Cross-user PATCH → 404.
- GET `/export` returns a `.stage` zip whose `manifest.json` reflects
  edits and still contains every slide + thumbnail.
- Cross-user export → 404.
- GET `/notes/audit` returns rows newest-first with the documented
  `NoteEditEntry` shape.
- A no-op PATCH adds **zero** audit rows (`updated: 0`).
- Cross-user audit GET → 404.

E2E (Playwright, `apps/web/tests/e2e/notes-edit.spec.ts`, 3 cases):
- Edit speaker notes in the Speaker side panel → autosave → press `Esc`
  to exit Edit mode → reload → still there → click **Export ↓** → unzip
  the download → assert `manifest.json` and `speaker-notes.json` carry
  the new note.
- Edit in the Presenter view bottom strip → autosave → navigate to the
  single-window viewer → Speaker side panel shows the same value.
- Edit-mode lock guard: clicking the locked panel doesn't trap nav keys
  (←/→ keep advancing slides); pressing `Edit ✎` then typing fills the
  textarea; `Esc` returns control and ←/→ advance again.

Run:

```bash
pnpm test:server               # vitest, ~1.5 s
pnpm test:e2e                  # Playwright, ~13 s
```

## 8. Operational notes

- **Atomicity**. Disk writes go through `<file>.tmp-<uuid>` + `rename`. A
  process crash between the manifest write and the speaker-notes write
  would leave a stale `.tmp-*` behind; the export route filters those
  out, and a future cleanup pass can `rm` them safely.
- **Concurrency**. The PATCH handler is last-writer-wins per deck. A
  second PATCH that arrives mid-flight will read the post-first-write
  manifest, so its diff is computed against the latest text. There's no
  CRDT — owner-only editing makes conflicts vanishingly rare.
- **Export size**. `adm-zip` builds the archive in memory, then streams
  `Buffer` to the response. For the ≤200 MB cap this is fine; if the cap
  is raised, switch to a streamed packer (see TODO in
  `ARCHITECTURE.md` §13).
- **CORS**. The frontend triggers downloads via `<a download>` after a
  same-origin GET, so no extra CORS plumbing was needed beyond the
  existing dev allowlist.

## 9. Manual smoke test

```
1.  pnpm dev                            # terminals: web :5173 + server :4000
2.  Open http://localhost:5173/decks
3.  Upload fixtures/out/sample.stage (run `pnpm fixtures` first if missing)
4.  Click into the deck → press S to open the Speaker side panel
5.  The notes area is locked by default — read-only `<pre>` of slide 2's notes,
    with an Edit ✎ button in the top-right
6.  Click Edit ✎; the area becomes a textarea; type changes
7.  Watch the pill cycle Editing… → Saving… → Saved ✓
8.  Press Esc (or click Done); the area locks again, showing the new text
9.  Refresh the page; press S; the new text is still there (read-only view)
10. Click Export ↓ — a `<id>-<timestamp>.stage` lands in your Downloads
11. `unzip -p <file> manifest.json | jq '.slides[1].notes'` confirms the edit
12. `curl -H 'x-user-id: <you>' http://localhost:4000/api/decks/<id>/notes/audit | jq` shows the audit row
```
