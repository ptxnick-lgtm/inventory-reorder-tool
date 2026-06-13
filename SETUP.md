# Inventory Reorder Tool — Setup Guide

This is a web app. Your mom visits a URL, drags in a QuickBooks inventory export
(CSV or Excel), and gets a sorted reorder list she can download as a PDF. Every
upload is stored, so the tool learns depletion trends over time.

There are three free services involved:
- **GitHub** — holds the code (already where this lives).
- **Supabase** — the database that stores every inventory snapshot.
- **Vercel** — hosts the live website.

You only set this up once. Budget ~20 minutes.

---

## Step 1 — Create the Supabase project (the database)

1. Go to https://supabase.com and sign up (free, no card).
2. Click **New project**. Name it anything (e.g. "inventory"). Choose a region
   near you. Set a database password (save it somewhere; you won't need it daily).
3. Wait ~2 minutes for it to finish provisioning.

## Step 2 — Get your two Supabase keys

1. In your Supabase project, go to **Project Settings → API**.
2. Copy these two values — you'll paste them into Vercel in Step 5:
   - **Project URL** (looks like `https://abcd1234.supabase.co`)
   - **anon public** key (a long string under "Project API keys")

## Step 3 — Create the database tables

1. In Supabase, open the **SQL Editor** (left sidebar).
2. Click **New query**.
3. Open the file `supabase-schema.sql` from this project, copy ALL of it, paste
   into the editor, and click **Run**.
4. You should see "Success." This creates the snapshot, vendor, and import tables,
   and pre-loads all your known vendors with the 15 exclusions already set.

## Step 4 — Connect the repo to Vercel

1. Go to https://vercel.com and sign up with your GitHub account (free).
2. Click **Add New → Project**.
3. Select this repository from the list and click **Import**.
4. Don't deploy yet — first add the environment variables (Step 5).

## Step 5 — Add your Supabase keys to Vercel

1. On the Vercel import screen, expand **Environment Variables**.
2. Add these two (names must match exactly):
   - `NEXT_PUBLIC_SUPABASE_URL` = your Project URL from Step 2
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = your anon public key from Step 2
3. Click **Deploy**. Wait ~1 minute.
4. Vercel gives you a URL (like `inventory-xyz.vercel.app`). That's the live site.
   Bookmark it for your mom.

## Step 6 — Keep Supabase awake (important for monthly use)

Supabase's free tier pauses a project after 7 days of no activity. Since this
tool is used about once a month, set up a free keep-alive ping so it's never
asleep when your mom needs it:

1. Go to https://uptimerobot.com and sign up (free).
2. Add a new monitor → **HTTP(s)**.
3. URL: your Supabase Project URL from Step 2.
4. Monitoring interval: every 5 minutes (or the longest the free plan allows).
5. Save. This quietly pings Supabase so it never pauses.

(Check this is still running every few months — it's the one thing that can
silently lapse.)

---

## Using it (for your mom)

1. In QuickBooks, open the Physical Inventory Worksheet report.
2. Click the **Excel** button → choose CSV (or Excel), and save the file.
3. Go to the bookmarked website.
4. Drag the file onto the page.
5. Check the snapshot date, click **Save & analyze**.
6. Review the color-coded list:
   - **Red — Order now**: out of stock, or running out before a reorder arrives.
   - **Orange — Order soon**: will need ordering before next month.
   - **Yellow — Low priority**: out for a while with no movement; low demand.
   - **Green — Already ordered**: on a purchase order; no action.
7. Click **Download PDF** for a printable reorder list.

## Notes

- The first upload gives basic results. The "order now / order soon" timing gets
  smarter with each month of history (it learns how fast things sell).
- New vendors: if QuickBooks shows a vendor the tool doesn't know, it's added
  automatically (you'll see a note). You can set its delivery lead time under
  **Vendor settings**.
- To change which vendors are excluded or how long each takes to deliver, use the
  **Vendor settings** button on the site.
- Sample files are in `sample-data/` if you want to test before using real exports.
