-- ============================================================================
-- DeepGuard — Supabase `profiles` table
-- Run ONCE in: Supabase Dashboard → SQL Editor → New query → paste → Run.
-- Safe to re-run (idempotent).
--
-- WHY: until now users only lived in Supabase's built-in auth.users, and the
-- role was stored in user_metadata. There was no table of your own, and
-- user_metadata can be edited by the logged-in user themselves
-- (supabase.auth.updateUser({ data: { role: 'admin' } })), so it must not be
-- trusted for permissions. This table is the single source of truth for roles.
-- ============================================================================

-- 1) The table ---------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  full_name   text,
  role        text not null default 'auditor'
              check (role in ('admin', 'auditor', 'analyst')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists profiles_role_idx  on public.profiles (role);
create index if not exists profiles_email_idx on public.profiles (email);

-- 2) Row Level Security ------------------------------------------------------
-- A logged-in user may READ only their own row. Nobody using the public
-- (anon / authenticated) keys can insert, update or delete — so a user can't
-- promote themselves. Your Node backend uses the service_role key, which
-- bypasses RLS, and is the only thing that changes roles.
alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles for select
  to authenticated
  using (auth.uid() = id);

revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;

-- 3) Auto-create a profile whenever a user signs up --------------------------
-- NOTE: the role is ALWAYS 'auditor' here. We deliberately ignore any role the
-- browser put in the sign-up metadata. Admins are promoted only by the backend
-- (PATCH /api/admin/users/:id/role) or by the create-demo-users.js script.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'full_name')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 4) Keep the profile email in sync if a user changes their email ------------
create or replace function public.handle_user_email_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles
     set email = new.email, updated_at = now()
   where id = new.id;
  return new;
end;
$$;

drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row
  when (old.email is distinct from new.email)
  execute function public.handle_user_email_change();

-- 5) Back-fill users that already exist (e.g. your demo accounts) ------------
-- One-time: keeps the role they already had in user_metadata so your current
-- admin keeps working. Review the result with the query at the bottom.
insert into public.profiles (id, email, role)
select u.id,
       u.email,
       case when u.raw_user_meta_data ->> 'role' in ('admin', 'auditor', 'analyst')
            then u.raw_user_meta_data ->> 'role'
            else 'auditor' end
from auth.users u
on conflict (id) do nothing;

-- 6) Check it worked ---------------------------------------------------------
-- select id, email, role, created_at from public.profiles order by created_at;
