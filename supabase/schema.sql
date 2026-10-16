-- Plandot: the tables and access rules behind sign-in.
--
-- How to use it: in Supabase open "SQL Editor", choose "New query", paste this whole file and click "Run".
-- You should see "Success. No rows returned". It is safe to run again.
--
-- What it does:
--   * profiles: one row per account with its plan (free, staff or paid). People can read their own row
--     but nobody can change it from the website, so nobody can give themselves a better plan.
--   * rule_sets: one row per account holding that person's saved rules. People can only see and change their own.
--   * delete_my_account(): lets a signed-in person delete their own account and everything above.
--   * Visitors who are not signed in cannot read or write anything.
-- Drawings and templates are never stored: they stay in the browser.

-- ---------------------------------------------------------------- tables
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text,
  plan       text not null default 'free' check (plan in ('free', 'staff', 'paid')),
  created_at timestamptz not null default now()
);

create table if not exists public.rule_sets (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb not null check (jsonb_typeof(data) = 'object' and octet_length(data::text) <= 524288),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- who can do what
alter table public.profiles  enable row level security;
alter table public.rule_sets enable row level security;

-- Start from nothing, then give back only what is needed. Visitors who are not signed in get nothing.
revoke all on public.profiles  from anon, authenticated;
revoke all on public.rule_sets from anon, authenticated;
grant select on public.profiles to authenticated;
grant select, insert, update, delete on public.rule_sets to authenticated;

drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles
  for select to authenticated using (id = (select auth.uid()));
-- There is deliberately no insert, update or delete policy on profiles.

drop policy if exists "read own rules" on public.rule_sets;
create policy "read own rules" on public.rule_sets
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "add own rules" on public.rule_sets;
create policy "add own rules" on public.rule_sets
  for insert to authenticated with check (user_id = (select auth.uid()));

drop policy if exists "change own rules" on public.rule_sets;
create policy "change own rules" on public.rule_sets
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "delete own rules" on public.rule_sets;
create policy "delete own rules" on public.rule_sets
  for delete to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------- housekeeping
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists rule_sets_touch on public.rule_sets;
create trigger rule_sets_touch before update on public.rule_sets
  for each row execute function public.touch_updated_at();

-- Every new account gets a profile. Hilti and Fieldwire addresses are marked "staff" (free access).
-- An address only counts once its owner has typed the emailed code, so nobody can use someone else's.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, plan)
  values (
    new.id,
    lower(new.email),
    case when lower(coalesce(new.email, '')) ~ '@(hilti|fieldwire)\.com$' then 'staff' else 'free' end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;
revoke all on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Accounts that already exist (only matters if you run this after people have signed in).
insert into public.profiles (id, email, plan)
select u.id, lower(u.email),
       case when lower(coalesce(u.email, '')) ~ '@(hilti|fieldwire)\.com$' then 'staff' else 'free' end
from auth.users u
on conflict (id) do nothing;

-- ---------------------------------------------------------------- delete my account
-- Deleting the sign-in record removes the profile and saved rules too, because they are tied to it.
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;
  delete from auth.users where id = me;
end;
$$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
