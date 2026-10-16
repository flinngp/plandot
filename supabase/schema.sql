-- Plandot: the tables and access rules behind sign-in.
--
-- How to use it: in Supabase open "SQL Editor", choose "New query", paste this whole file and click "Run".
-- You should see "Success. No rows returned". It is safe to run again.
--
-- What it does:
--   * profiles: one row per account with its plan (free, staff or paid). People can read their own row
--     but nobody can change it from the website, so nobody can give themselves a better plan.
--   * saved_rules: one row per saved rule (each has a name). People can only see and change their own, up to 200.
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

-- The first version kept one blob of rules per person. It is replaced by one row per named rule.
drop table if exists public.rule_sets;

create table if not exists public.saved_rules (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  name       text not null check (char_length(btrim(name)) between 1 and 80),
  data       jsonb not null check (jsonb_typeof(data) = 'object' and octet_length(data::text) <= 262144),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

-- ---------------------------------------------------------------- who can do what
alter table public.profiles  enable row level security;
alter table public.saved_rules enable row level security;

-- Start from nothing, then give back only what is needed. Visitors who are not signed in get nothing.
revoke all on public.profiles  from anon, authenticated;
revoke all on public.saved_rules from anon, authenticated;
grant select on public.profiles to authenticated;
grant select, insert, update, delete on public.saved_rules to authenticated;

drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles
  for select to authenticated using (id = (select auth.uid()));
-- There is deliberately no insert, update or delete policy on profiles.

drop policy if exists "read own rules" on public.saved_rules;
create policy "read own rules" on public.saved_rules
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "add own rules" on public.saved_rules;
create policy "add own rules" on public.saved_rules
  for insert to authenticated with check (user_id = (select auth.uid()));

drop policy if exists "change own rules" on public.saved_rules;
create policy "change own rules" on public.saved_rules
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "delete own rules" on public.saved_rules;
create policy "delete own rules" on public.saved_rules
  for delete to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------- housekeeping
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists saved_rules_touch on public.saved_rules;
create trigger saved_rules_touch before update on public.saved_rules
  for each row execute function public.touch_updated_at();

-- A person can keep at most 200 saved rules, so nobody can fill the database.
create or replace function public.limit_saved_rules() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (select count(*) from public.saved_rules where user_id = new.user_id) >= 200 then
    raise exception 'Too many saved rules' using errcode = '54000';
  end if;
  return new;
end;
$$;

drop trigger if exists saved_rules_limit on public.saved_rules;
create trigger saved_rules_limit before insert on public.saved_rules
  for each row execute function public.limit_saved_rules();

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
