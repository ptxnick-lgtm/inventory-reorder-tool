# Inventory Reorder Tool

A web app that turns a QuickBooks inventory export (CSV/Excel) into a sorted,
color-coded reorder list — and builds a history so it learns what's depleting
fast and needs ordering before it hits zero.

## What it does

- Drag-and-drop a CSV/Excel inventory export (parsed in the browser).
- Stores each snapshot in Supabase, building an archive over time.
- Classifies every item into four tiers:
  - **Order now** — out of stock, or running out before a reorder could arrive.
  - **Order soon** — will cross the reorder threshold before next check.
  - **Low priority** — chronically out with no movement (low demand).
  - **Already ordered** — on a purchase order.
- Velocity logic: estimates weekly consumption from snapshot history and compares
  against each vendor's delivery lead time, so fast movers get flagged early.
- Excludes vendors you don't reorder here (15 pre-set, editable).
- Exports a printable PDF grouped by tier.

## Setup

See **SETUP.md** for step-by-step instructions (Supabase + Vercel + keep-alive).

## Tech

- Next.js (App Router), deployed on Vercel.
- Supabase (Postgres) for snapshot/vendor storage.
- Parsing in-browser via papaparse (CSV) and SheetJS (Excel).
- PDF export via jsPDF.

## Project structure

- `app/page.tsx` — upload UI + dashboard.
- `lib/parser.ts` — CSV/Excel parser (matches columns by header name).
- `lib/classify.ts` — the four-tier classification engine.
- `lib/vendors.ts` — canonical vendor list + matching + defaults.
- `lib/supabase.ts` — database access.
- `lib/exportPdf.ts` — sorted PDF generator.
- `supabase-schema.sql` — run once to create tables (see SETUP.md step 3).
- `sample-data/` — four real example CSVs for testing.

## Local development

```bash
npm install
cp .env.local.example .env.local   # fill in your Supabase keys
npm run dev
```
