-- ============================================================
-- Inventory Reorder Tool — Supabase schema
-- Run this once in the Supabase SQL Editor (see SETUP.md step 3)
-- ============================================================

-- Every parsed line from every uploaded snapshot. One row per item per date.
create table if not exists snapshots (
  id           bigint generated always as identity primary key,
  snapshot_date date    not null,
  item         text    not null,
  vendor       text    not null,
  qoh          integer not null default 0,
  po           integer not null default 0,
  reorder_min  integer,
  created_at   timestamptz default now()
);

-- If upgrading an existing database, add the reorder-minimum column:
alter table snapshots add column if not exists reorder_min integer;

create index if not exists idx_snapshots_date on snapshots (snapshot_date);
create index if not exists idx_snapshots_item_vendor on snapshots (item, vendor);

-- Prevent importing the same date twice for the same item/vendor.
create unique index if not exists uq_snapshot_row
  on snapshots (snapshot_date, item, vendor);

-- Log of which dates have been imported, so the UI can warn on duplicates.
create table if not exists imported_files (
  id            bigint generated always as identity primary key,
  snapshot_date date not null,
  filename      text,
  row_count     integer,
  imported_at   timestamptz default now()
);

-- Vendors: lead time (days) drives the velocity "order now" threshold.
create table if not exists vendors (
  name       text primary key,
  lead_days  integer not null default 14,
  excluded   boolean not null default false
);

-- Per-item reorder flags set in the app (e.g. discontinued / one-time buy) so
-- those items can be hidden from the reorder lists.
create table if not exists item_flags (
  item        text primary key,
  status      text not null default '',
  note        text,
  tags        text,
  updated_at  timestamptz default now()
);
-- If upgrading an existing item_flags table, add the note/tags columns:
alter table item_flags add column if not exists note text;
alter table item_flags add column if not exists tags text;

-- Per-product cost and sales price, entered by hand in the app. Drives the
-- revenue dashboard (units sold x price/cost between snapshots).
create table if not exists products (
  item        text primary key,
  cost        numeric not null default 0,
  price       numeric not null default 0,
  updated_at  timestamptz default now()
);

-- Seed the known vendors. Excluded = the ones that don't get scanned/ordered here.
insert into vendors (name, lead_days, excluded) values
  ('A Wild Soap Bar', 14, true),
  ('Amazon', 7, false),
  ('Apex', 14, false),
  ('Biogenesis', 14, false),
  ('Biotics', 14, false),
  ('Boiron', 14, false),
  ('Deep Steep Cleansing', 14, true),
  ('Desert Biologicals', 14, false),
  ('Designs For Health', 14, false),
  ('Diagnos-Techs', 14, true),
  ('Dr. Garber''s', 14, true),
  ('Drucker', 14, false),
  ('Electro Medical Technologies', 14, true),
  ('Emerson Ecologics', 14, false),
  ('Essence', 14, true),
  ('Faire', 14, false),
  ('Fontana Candle Co.', 14, true),
  ('Fullscript', 14, false),
  ('Global Healing', 14, false),
  ('GX Sciences', 14, true),
  ('Homeopathy Works', 14, true),
  ('Integrative Peptides', 14, false),
  ('Irving Health & Wellness', 14, true),
  ('Kari Gran', 14, false),
  ('Lady May Tallow', 14, false),
  ('Little Seed Farm', 14, false),
  ('MicroBiome Labs', 14, false),
  ('Mindful Minerals', 14, true),
  ('Nature''s Scent Co.', 14, true),
  ('Natures Sunshine', 14, false),
  ('Neuro Biologix', 14, false),
  ('Neurogan Health', 14, false),
  ('NuMedica', 14, false),
  ('Nutri-West', 14, false),
  ('Nutritional Frontiers', 14, false),
  ('Ortho Molecular', 14, false),
  ('Osborn, Brenda', 14, false),
  ('PatchAid', 14, false),
  ('Professional Formulas', 14, false),
  ('PurO3', 14, true),
  ('Queen of Thrones', 14, false),
  ('VasoLabs', 14, true),
  ('WAAYB', 14, false),
  ('Wild Herb Soap Co', 14, true),
  ('Xymogen EP', 14, false)
on conflict (name) do nothing;
