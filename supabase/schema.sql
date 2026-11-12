-- =============================================================================
-- Poker Texas Hold'em — base de données des comptes (Supabase / PostgreSQL)
--
-- À exécuter une seule fois dans Supabase : SQL Editor → New query → coller → Run.
-- Le script peut être relancé sans risque (il remplace les fonctions existantes).
--
-- Sécurité : les joueurs ne peuvent QUE lire leur propre profil. Toute
-- modification (pseudo, jetons, statistiques) passe par les fonctions
-- ci-dessous, qui vérifient les montants. Les jetons sont fictifs.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  pseudo       text not null check (char_length(pseudo) between 2 and 14),
  chips        bigint not null default 1000 check (chips >= 0),   -- solde de jetons fictifs
  games_played integer not null default 0,
  wins         integer not null default 0,
  best_place   integer,
  hands_won    integer not null default 0,
  biggest_pot  bigint not null default 0,
  refills      integer not null default 0,
  created_at   timestamptz not null default now()
);

-- Pseudo unique, sans tenir compte des majuscules
create unique index if not exists profiles_pseudo_unique on public.profiles (lower(pseudo));

-- Une ligne par partie commencée avec un compte (la mise est prélevée au départ)
create table if not exists public.games (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  players     integer not null check (players between 2 and 6),
  buy_in      integer not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  final_chips bigint,
  place       integer
);
create index if not exists games_user_idx on public.games (user_id);

-- Personnalisation du profil : cadre de couleur et photo (chemin dans le stockage « avatars »)
alter table public.profiles add column if not exists frame text not null default 'or';
alter table public.profiles add column if not exists avatar_path text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_frame_check') then
    alter table public.profiles add constraint profiles_frame_check
      check (frame in ('or', 'argent', 'rubis', 'emeraude', 'saphir', 'amethyste', 'neon', 'arcenciel'));
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Sécurité au niveau des lignes : lecture de ses propres données uniquement
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.games enable row level security;

drop policy if exists "Lecture de son profil" on public.profiles;
create policy "Lecture de son profil" on public.profiles
  for select to authenticated using (auth.uid() = id);

drop policy if exists "Lecture de ses parties" on public.games;
create policy "Lecture de ses parties" on public.games
  for select to authenticated using (auth.uid() = user_id);

-- Aucune politique d'écriture : seules les fonctions ci-dessous modifient les données.

-- Droits explicites (certains projets Supabase n'exposent pas automatiquement les nouvelles tables)
grant usage on schema public to anon, authenticated;
grant select on public.profiles to authenticated;
grant select on public.games to authenticated;
revoke insert, update, delete on public.profiles from anon, authenticated;
revoke insert, update, delete on public.games from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Création automatique du profil à l'inscription
-- (pseudo transmis par l'application dans les métadonnées ; si déjà pris
--  entre-temps, un numéro est ajouté)
-- ---------------------------------------------------------------------------

-- Pseudo libre à partir du pseudo souhaité (ajoute un numéro si besoin)
create or replace function public.free_pseudo(p_wanted text)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  wanted    text := left(coalesce(nullif(btrim(p_wanted), ''), 'Joueur'), 14);
  candidate text;
  n         integer := 1;
begin
  if char_length(wanted) < 2 then
    wanted := 'Joueur';
  end if;
  candidate := wanted;
  while exists (select 1 from public.profiles where lower(pseudo) = lower(candidate)) loop
    n := n + 1;
    candidate := left(wanted, 14 - char_length(n::text)) || n::text;
  end loop;
  return candidate;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, pseudo)
  values (new.id, public.free_pseudo(new.raw_user_meta_data ->> 'pseudo'))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Fonctions appelées par le jeu
-- ---------------------------------------------------------------------------

-- Profil du joueur connecté, créé s'il manque (compte créé avant l'installation de ce script)
create or replace function public.ensure_profile()
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  uid    uuid := auth.uid();
  result public.profiles;
begin
  if uid is null then raise exception 'Vous devez être connecté.'; end if;
  select * into result from public.profiles where id = uid;
  if found then return result; end if;
  insert into public.profiles (id, pseudo)
  select uid, public.free_pseudo(u.raw_user_meta_data ->> 'pseudo') from auth.users u where u.id = uid
  on conflict (id) do nothing;
  select * into result from public.profiles where id = uid;
  return result;
end;
$$;

-- Le pseudo est-il libre ? (utilisable sans compte : sert aussi aux invités)
create or replace function public.pseudo_available(p_pseudo text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not exists (select 1 from public.profiles where lower(pseudo) = lower(btrim(p_pseudo)));
$$;

-- Changer de pseudo
create or replace function public.set_pseudo(p_pseudo text)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  uid     uuid := auth.uid();
  cleaned text := btrim(regexp_replace(coalesce(p_pseudo, ''), '\s+', ' ', 'g'));
  result  public.profiles;
begin
  if uid is null then raise exception 'Vous devez être connecté.'; end if;
  if char_length(cleaned) not between 2 and 14 then
    raise exception 'Le pseudo doit faire entre 2 et 14 caractères.';
  end if;
  if exists (select 1 from public.profiles where lower(pseudo) = lower(cleaned) and id <> uid) then
    raise exception 'Ce pseudo est déjà pris.';
  end if;
  update public.profiles set pseudo = cleaned where id = uid returning * into result;
  return result;
end;
$$;

-- Choisir le cadre de son avatar
create or replace function public.set_frame(p_frame text)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  uid    uuid := auth.uid();
  result public.profiles;
begin
  if uid is null then raise exception 'Vous devez être connecté.'; end if;
  if p_frame is null or p_frame not in ('or', 'argent', 'rubis', 'emeraude', 'saphir', 'amethyste', 'neon', 'arcenciel') then
    raise exception 'Cadre inconnu.';
  end if;
  update public.profiles set frame = p_frame where id = uid returning * into result;
  return result;
end;
$$;

-- Enregistrer (ou retirer, avec null) sa photo, déjà envoyée dans son dossier du stockage « avatars »
create or replace function public.set_avatar(p_path text)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  uid    uuid := auth.uid();
  result public.profiles;
begin
  if uid is null then raise exception 'Vous devez être connecté.'; end if;
  if p_path is not null and p_path !~ ('^' || uid::text || '/avatar-[0-9]{1,16}\.(webp|jpg|png)$') then
    raise exception 'Chemin de photo invalide.';
  end if;
  update public.profiles set avatar_path = p_path where id = uid returning * into result;
  return result;
end;
$$;

-- Début de partie : prélève la mise (1 000 jetons) et ouvre une partie
create or replace function public.start_game(p_players integer)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  uid     uuid := auth.uid();
  buy_in  constant integer := 1000;
  game_id bigint;
begin
  if uid is null then raise exception 'Vous devez être connecté.'; end if;
  if p_players is null or p_players not between 2 and 6 then
    raise exception 'Nombre de joueurs invalide.';
  end if;
  update public.profiles set chips = chips - buy_in where id = uid and chips >= buy_in;
  if not found then
    raise exception 'Solde insuffisant : il faut 1 000 jetons pour s''asseoir à une table.';
  end if;
  insert into public.games (user_id, players, buy_in) values (uid, p_players, buy_in)
  returning id into game_id;
  return game_id;
end;
$$;

-- Fin de partie : rend les jetons restants et met à jour les statistiques.
-- Les valeurs sont bornées (on ne peut pas repartir avec plus que tous les jetons de la table).
create or replace function public.finish_game(
  p_game        bigint,
  p_final_chips bigint,
  p_place       integer,
  p_hands_won   integer,
  p_biggest_pot bigint
)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  uid       uuid := auth.uid();
  g         public.games;
  table_max bigint;
  result    public.profiles;
begin
  if uid is null then raise exception 'Vous devez être connecté.'; end if;

  select * into g from public.games where id = p_game and user_id = uid for update;
  if not found then raise exception 'Partie introuvable.'; end if;
  if g.finished_at is not null then raise exception 'Cette partie est déjà enregistrée.'; end if;

  table_max := g.buy_in::bigint * g.players;
  if p_final_chips is null or p_final_chips < 0 or p_final_chips > table_max then
    raise exception 'Montant de fin de partie invalide.';
  end if;
  if p_place is null or p_place < 1 or p_place > g.players then
    raise exception 'Place invalide.';
  end if;
  if p_hands_won is null or p_hands_won < 0 or p_hands_won > 10000 then
    raise exception 'Nombre de mains gagnées invalide.';
  end if;
  if p_biggest_pot is null or p_biggest_pot < 0 or p_biggest_pot > table_max then
    raise exception 'Montant du plus gros pot invalide.';
  end if;

  update public.games
     set finished_at = now(), final_chips = p_final_chips, place = p_place
   where id = g.id;

  update public.profiles
     set chips        = chips + p_final_chips,
         games_played = games_played + 1,
         wins         = wins + case when p_place = 1 then 1 else 0 end,
         best_place   = least(coalesce(best_place, p_place), p_place),
         hands_won    = hands_won + p_hands_won,
         biggest_pot  = greatest(biggest_pot, p_biggest_pot)
   where id = uid
  returning * into result;
  return result;
end;
$$;

-- Recharge gratuite : remet le solde à 1 000 jetons s'il est en dessous
create or replace function public.refill_chips()
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  uid    uuid := auth.uid();
  result public.profiles;
begin
  if uid is null then raise exception 'Vous devez être connecté.'; end if;
  update public.profiles
     set chips = 1000, refills = refills + 1
   where id = uid and chips < 1000
  returning * into result;
  if not found then
    raise exception 'Votre solde est déjà d''au moins 1 000 jetons.';
  end if;
  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Stockage des photos de profil (bucket public « avatars », 512 Ko max par image)
-- Chaque joueur ne peut écrire que dans son dossier : avatars/<son identifiant>/…
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 524288, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do update
  set public = true,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Avatars : lecture de son dossier" on storage.objects;
create policy "Avatars : lecture de son dossier" on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Avatars : envoi dans son dossier" on storage.objects;
create policy "Avatars : envoi dans son dossier" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Avatars : remplacement dans son dossier" on storage.objects;
create policy "Avatars : remplacement dans son dossier" on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Avatars : suppression dans son dossier" on storage.objects;
create policy "Avatars : suppression dans son dossier" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------------------------------------------------------------------------
-- Droits d'exécution
-- ---------------------------------------------------------------------------

revoke all on function public.handle_new_user() from public;
revoke all on function public.free_pseudo(text) from public;
revoke all on function public.ensure_profile() from public;
revoke all on function public.pseudo_available(text) from public;
revoke all on function public.set_pseudo(text) from public;
revoke all on function public.set_frame(text) from public;
revoke all on function public.set_avatar(text) from public;
revoke all on function public.start_game(integer) from public;
revoke all on function public.finish_game(bigint, bigint, integer, integer, bigint) from public;
revoke all on function public.refill_chips() from public;

grant execute on function public.pseudo_available(text) to anon, authenticated;
grant execute on function public.ensure_profile() to authenticated;
grant execute on function public.set_pseudo(text) to authenticated;
grant execute on function public.set_frame(text) to authenticated;
grant execute on function public.set_avatar(text) to authenticated;
grant execute on function public.start_game(integer) to authenticated;
grant execute on function public.finish_game(bigint, bigint, integer, integer, bigint) to authenticated;
grant execute on function public.refill_chips() to authenticated;
