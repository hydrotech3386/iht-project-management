# IHT Project Management

Internal project management tool for **Ipoh Hydrotech Engineering Sdn Bhd**.

**Live:** https://hydrotech3386.github.io/iht-project-management/

## What it does

Upload a customer **PO / BQ / Quotation** → Claude reads the document and extracts every
scope line item → each item is tracked with a **% complete** → the project's overall
progress is a **weighted roll-up** by item value.

| Section | Purpose |
|---|---|
| Dashboard | Active projects, overdue, average completion, open items |
| Projects | Cards → detail with Overview / Items / Documents |
| Items | Every scope item across all projects, inline % editing |
| Documents | Uploaded POs, BQs, drawings per project |
| Users | Role management (admin only) |

## Progress calculation

Each item's weight is its value (`qty × rate`), falling back to quantity, then 1.

```
project % = Σ(weight × percent) / Σ(weight)
```

So a RM34,000 item at 100% moves the needle far more than a RM1,500 item at 100%.
Set a project to *Manual %* in its form to override this.

## Adding items

1. **Extract items with AI** — reads the uploaded PO/BQ (PDF or photo/scan)
2. **Paste items** — one per line: `Description | Qty | Unit | Rate`
3. **+ Item** — manual entry

AI extraction always shows a **review screen** first: edit or drop rows before they commit.

## Architecture

Single-file vanilla-JS app (`index.html`) — no build step. Backed by Firebase:

- **Auth** — email/password, roles `admin` / `editor` / `view`
- **Realtime Database** — live sync across devices
- **Storage** — uploaded documents (PDF/images, 25MB cap)
- **Cloud Function `extractItems`** — `asia-southeast1`, reads the document from
  Storage and calls Claude. The Anthropic API key lives in Google Secret Manager
  and **never reaches the browser**.

This app shares the `iht-project-schedule` Firebase project, so all of its data is
namespaced under **`pm/`** (`pm/projects`, `pm/items`, `pm/documents`, `pm/users`,
and Storage under `pm/projects/{id}/`). Nothing is ever written outside `pm/`.

`?view` on the URL gives a read-only view with no login.

## Deploying

The app itself is served by GitHub Pages — just push to `main`.

Backend changes need the Firebase CLI:

```bash
npm install firebase-tools --prefix ./tooling

# security rules
./tooling/node_modules/.bin/firebase deploy --only storage --project iht-project-schedule

# the extraction function
./tooling/node_modules/.bin/firebase deploy --only functions --project iht-project-schedule

# rotate the Anthropic key
./tooling/node_modules/.bin/firebase functions:secrets:set ANTHROPIC_API_KEY --project iht-project-schedule
```
