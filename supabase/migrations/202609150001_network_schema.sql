create table if not exists public.network_blocks (
  chain_id text not null,
  height bigint primary key,
  block_hash text not null unique,
  previous_hash text not null,
  transactions_root text not null,
  state_root text not null,
  proposer text not null,
  block_data jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.network_transactions (
  transaction_hash text primary key,
  chain_id text not null,
  sender text not null,
  recipient text not null,
  amount_bdu numeric(30, 0) not null check (amount_bdu > 0),
  fee_bdu numeric(30, 0) not null default 0 check (fee_bdu >= 0),
  nonce bigint not null check (nonce >= 0),
  block_height bigint references public.network_blocks(height),
  transaction_data jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.network_accounts (
  address text primary key,
  balance_bdu numeric(30, 0) not null default 0 check (balance_bdu >= 0),
  nonce bigint not null default 0 check (nonce >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.network_validators (
  validator_id text primary key,
  public_key text not null,
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.network_anchors (
  anchor_id text primary key,
  chain_id text not null,
  height bigint not null references public.network_blocks(height),
  checkpoint_root text not null,
  anchor_data jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists network_transactions_sender_idx on public.network_transactions(sender);
create index if not exists network_transactions_recipient_idx on public.network_transactions(recipient);
create index if not exists network_anchors_height_idx on public.network_anchors(height desc);

alter table public.network_blocks enable row level security;
alter table public.network_transactions enable row level security;
alter table public.network_accounts enable row level security;
alter table public.network_validators enable row level security;
alter table public.network_anchors enable row level security;

create policy "public can read finalized blocks" on public.network_blocks for select using (true);
create policy "public can read finalized transactions" on public.network_transactions for select using (true);
create policy "public can read accounts" on public.network_accounts for select using (true);
create policy "public can read active validators" on public.network_validators for select using (active = true);
create policy "public can read anchors" on public.network_anchors for select using (true);
