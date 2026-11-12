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
-- Parties classées : cote (style Elo) et statistiques dédiées
alter table public.profiles add column if not exists rating integer not null default 1000;
alter table public.profiles add column if not exists ranked_played integer not null default 0;
alter table public.profiles add column if not exists ranked_wins integer not null default 0;

-- File d'attente du matchmaking (comptes vérifiés uniquement)
create table if not exists public.match_queue (
  user_id   uuid primary key references auth.users (id) on delete cascade,
  rating    integer not null,
  joined_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);

-- Tables formées par le matchmaking : l'hôte publie le code de sa table
create table if not exists public.matches (
  id         bigint generated always as identity primary key,
  host_id    uuid not null references auth.users (id) on delete cascade,
  code       text,
  status     text not null default 'forming' check (status in ('forming', 'playing', 'cancelled')),
  created_at timestamptz not null default now()
);
create table if not exists public.match_players (
  match_id      bigint not null references public.matches (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  pseudo        text not null,
  rating_before integer not null,
  opponents_avg integer not null,
  primary key (match_id, user_id)
);
create index if not exists match_players_user_idx on public.match_players (user_id);

alter table public.games add column if not exists match_id bigint references public.matches (id) on delete set null;
alter table public.games add column if not exists rating_delta integer;

alter table public.match_queue enable row level security;
alter table public.matches enable row level security;
alter table public.match_players enable row level security;
-- Aucune politique : ces tables ne sont lues et écrites que par les fonctions ci-dessous.

-- Annuaire des tables publiques (multijoueur) : l'hôte inscrit sa table et la tient à jour.
-- Une table sans nouvelles depuis 30 s n'apparaît plus. Accessible aussi aux invités (sans compte) :
-- chaque inscription reçoit un jeton secret, seul moyen de la modifier ou de la retirer.
create table if not exists public.open_tables (
  code        text primary key check (code ~ '^[A-Z0-9]{4,8}$'),
  host_pseudo text not null,
  host_user   uuid references auth.users (id) on delete cascade,  -- null pour un hôte invité
  players     integer not null default 1 check (players between 1 and 6),
  bots        integer not null default 0 check (bots between 0 and 5),
  difficulty  text not null default 'moyen' check (difficulty in ('facile', 'moyen', 'difficile')),
  token       uuid not null default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  last_seen   timestamptz not null default now()
);
alter table public.open_tables enable row level security;
-- Aucune politique : lecture et écriture uniquement par les fonctions (le jeton n'est jamais lisible).

-- Bonus horaire : date de la dernière récupération
alter table public.profiles add column if not exists last_bonus_at timestamptz;

-- Cadres achetés dans la boutique (le cadre « or » est gratuit pour tous)
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'profiles' and column_name = 'owned_frames') then
    alter table public.profiles add column owned_frames text[] not null default '{}';
    -- Les joueurs qui portaient déjà un cadre (gratuit jusqu'ici) le gardent
    update public.profiles set owned_frames = array[frame]
     where frame in ('argent', 'rubis', 'emeraude', 'saphir', 'amethyste', 'neon', 'arcenciel');
  end if;
end;
$$;

-- Cadres exclusifs attribués à un compte précis (voir grant_frame plus bas)
alter table public.profiles add column if not exists exclusive_frames text[] not null default '{}';

-- Cadres existants : 8 pour tout le monde + les cadres exclusifs
alter table public.profiles drop constraint if exists profiles_frame_check;
alter table public.profiles add constraint profiles_frame_check
  check (frame in ('or', 'argent', 'rubis', 'emeraude', 'saphir', 'amethyste', 'neon', 'arcenciel', 'couronne'));

-- Titre affiché sous le pseudo (débloqué grâce aux statistiques)
alter table public.profiles add column if not exists title text not null default 'debutant';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_title_check') then
    alter table public.profiles add constraint profiles_title_check
      check (title in ('debutant', 'habitue', 'veteran', 'vainqueur', 'requin', 'legende',
                       'main_heureuse', 'gros_pot', 'flambeur', 'phenix', 'riche', 'magnat'));
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
  me     public.profiles;
  result public.profiles;
begin
  if uid is null then raise exception 'Vous devez être connecté.'; end if;
  select * into me from public.profiles where id = uid;
  if not found then raise exception 'Profil introuvable.'; end if;
  if p_frame is null or p_frame not in ('or', 'argent', 'rubis', 'emeraude', 'saphir', 'amethyste', 'neon', 'arcenciel', 'couronne') then
    raise exception 'Cadre inconnu.';
  end if;
  if p_frame = 'couronne' then
    -- Cadre exclusif : seulement s'il a été attribué à ce compte
    if p_frame <> all (me.exclusive_frames) then
      raise exception 'Ce cadre est réservé à un autre compte.';
    end if;
  elsif public.frame_price(p_frame) > 0 and p_frame <> all (me.owned_frames) then
    -- Cadre de la boutique : seulement s'il a été acheté
    raise exception 'Achetez d''abord ce cadre dans la boutique.';
  end if;
  update public.profiles set frame = p_frame where id = uid returning * into result;
  return result;
end;
$$;

-- Prix des cadres de la boutique, en jetons (null : pas en vente)
create or replace function public.frame_price(p_frame text)
returns integer
language sql
immutable
as $$
  select case p_frame
    when 'or'        then 0
    when 'argent'    then 2000
    when 'rubis'     then 3000
    when 'emeraude'  then 3000
    when 'saphir'    then 3000
    when 'amethyste' then 4000
    when 'neon'      then 7500
    when 'arcenciel' then 10000
    else null
  end;
$$;

-- Acheter un cadre : les jetons sont débités, le cadre est ajouté et porté tout de suite
create or replace function public.buy_frame(p_frame text)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  uid    uuid := auth.uid();
  price  integer := public.frame_price(p_frame);
  me     public.profiles;
  result public.profiles;
begin
  if uid is null then raise exception 'Vous devez être connecté.'; end if;
  if price is null or price = 0 then raise exception 'Ce cadre n''est pas en vente.'; end if;
  select * into me from public.profiles where id = uid for update;
  if not found then raise exception 'Profil introuvable.'; end if;
  if p_frame = any (me.owned_frames) then raise exception 'Vous possédez déjà ce cadre.'; end if;
  if me.chips < price then
    raise exception 'Solde insuffisant : ce cadre coûte % jetons.', price;
  end if;
  update public.profiles
     set chips = chips - price,
         owned_frames = owned_frames || array[p_frame],
         frame = p_frame
   where id = uid
  returning * into result;
  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Matchmaking (parties classées) : comptes à l'adresse e-mail confirmée uniquement
-- Les joueurs appellent poll_queue toutes les 2 secondes ; le serveur forme les tables.
-- ---------------------------------------------------------------------------

-- Le compte a-t-il confirmé son adresse e-mail ?
create or replace function public.account_verified(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select email_confirmed_at is not null from auth.users where id = p_user), false);
$$;

-- Partie classée en cours (ou en formation) pour un joueur
create or replace function public.current_match(p_user uuid)
returns public.matches
language sql
stable
security definer
set search_path = public
as $$
  select m.* from public.matches m
  join public.match_players mp on mp.match_id = m.id
  where mp.user_id = p_user
    and m.status in ('forming', 'playing')
    and m.created_at > now() - interval '3 hours'
    and not exists (select 1 from public.games g where g.match_id = m.id and g.user_id = p_user and g.finished_at is not null)
    -- une table jamais lancée est abandonnée au bout de 75 secondes
    and (m.status = 'playing' or m.created_at > now() - interval '75 seconds')
  order by m.id desc
  limit 1;
$$;

-- Entrer dans la file d'attente
create or replace function public.join_queue()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  me  public.profiles;
begin
  if uid is null then raise exception 'Vous devez être connecté.'; end if;
  if not public.account_verified(uid) then
    raise exception 'Confirmez votre adresse e-mail pour jouer en partie classée.';
  end if;
  select * into me from public.profiles where id = uid;
  if not found then raise exception 'Profil introuvable.'; end if;
  if me.chips < 1000 then
    raise exception 'Solde insuffisant : il faut 1 000 jetons pour une partie classée.';
  end if;
  -- Déjà placé à une table : on ne rentre pas une deuxième fois dans la file
  if (public.current_match(uid)).id is not null then
    return public.poll_queue();
  end if;
  insert into public.match_queue (user_id, rating) values (uid, me.rating)
  on conflict (user_id) do update set last_seen = now(), rating = excluded.rating;
  return public.poll_queue();
end;
$$;

-- Quitter la file d'attente
create or replace function public.leave_queue()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.match_queue where user_id = auth.uid();
$$;

-- État du joueur dans le matchmaking ; forme une table quand c'est possible
create or replace function public.poll_queue()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid      uuid := auth.uid();
  m        public.matches;
  oldest   public.match_queue;
  waited   numeric;
  gap      numeric;
  chosen   uuid[];
  new_id   bigint;
  mine     public.match_queue;
begin
  if uid is null then raise exception 'Vous devez être connecté.'; end if;
  perform pg_advisory_xact_lock(724001); -- un seul appel à la fois forme les tables

  -- Déjà placé à une table ?
  m := public.current_match(uid);
  if m.id is not null then
    return jsonb_build_object(
      'status', 'matched',
      'match_id', m.id,
      'role', case when m.host_id = uid then 'host' else 'guest' end,
      'code', m.code,
      'players', (select jsonb_agg(jsonb_build_object('pseudo', pseudo, 'rating', rating_before) order by rating_before desc)
                  from public.match_players where match_id = m.id));
  end if;

  update public.match_queue set last_seen = now() where user_id = uid returning * into mine;
  if mine.user_id is null then
    return jsonb_build_object('status', 'idle');
  end if;

  -- Les joueurs qui ne donnent plus de nouvelles quittent la file
  delete from public.match_queue where last_seen < now() - interval '15 seconds';

  -- Table autour du joueur qui attend depuis le plus longtemps, cotes proches
  -- (l'écart toléré grandit avec l'attente : 150 points + 25 par seconde)
  select * into oldest from public.match_queue order by joined_at limit 1;
  waited := extract(epoch from now() - oldest.joined_at);
  gap := 150 + 25 * waited;
  select array_agg(user_id) into chosen from (
    select user_id from public.match_queue
    where abs(rating - oldest.rating) <= gap
      and (public.current_match(user_id)).id is null
    order by joined_at
    limit 6
  ) c;

  if coalesce(array_length(chosen, 1), 0) >= 6
     or (coalesce(array_length(chosen, 1), 0) >= 2 and waited >= 10) then
    insert into public.matches (host_id) values (oldest.user_id) returning id into new_id;
    insert into public.match_players (match_id, user_id, pseudo, rating_before, opponents_avg)
    select new_id, p.id, p.pseudo, p.rating,
           coalesce((select round(avg(o.rating)) from public.profiles o where o.id = any (chosen) and o.id <> p.id), p.rating)
    from public.profiles p where p.id = any (chosen);
    delete from public.match_queue where user_id = any (chosen);
    if uid = any (chosen) then
      return public.poll_queue();
    end if;
  end if;

  return jsonb_build_object(
    'status', 'waiting',
    'waiting', (select count(*) from public.match_queue),
    'seconds', floor(extract(epoch from now() - mine.joined_at)));
end;
$$;

-- L'hôte publie le code de sa table
create or replace function public.set_match_code(p_match bigint, p_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_code is null or p_code !~ '^[A-Z0-9]{4,8}$' then raise exception 'Code de table invalide.'; end if;
  update public.matches set code = p_code
   where id = p_match and host_id = auth.uid() and status = 'forming';
  if not found then raise exception 'Partie classée introuvable.'; end if;
end;
$$;

-- L'hôte annule une table qui n'a pas pu démarrer
create or replace function public.cancel_match(p_match bigint)
returns void
language sql
security definer
set search_path = public
as $$
  update public.matches set status = 'cancelled'
   where id = p_match and host_id = auth.uid() and status = 'forming';
$$;

-- ---------------------------------------------------------------------------
-- Tables publiques : inscription, mise à jour, retrait, liste
-- ---------------------------------------------------------------------------

-- Inscrit une table publique ; renvoie le jeton secret de l'hôte
create or replace function public.open_table(p_code text, p_pseudo text, p_players integer, p_bots integer, p_difficulty text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  uid     uuid := auth.uid();
  pseudo  text := btrim(regexp_replace(coalesce(p_pseudo, ''), '\s+', ' ', 'g'));
  result  uuid;
begin
  if p_code is null or p_code !~ '^[A-Z0-9]{4,8}$' then raise exception 'Code de table invalide.'; end if;
  if uid is not null then
    select p.pseudo into pseudo from public.profiles p where p.id = uid; -- pseudo du compte
  end if;
  if char_length(coalesce(pseudo, '')) not between 2 and 14 then raise exception 'Pseudo invalide.'; end if;
  if p_players is null or p_players not between 1 and 6 or p_bots is null or p_bots not between 0 and 5
     or p_players + p_bots > 6 then
    raise exception 'Nombre de joueurs invalide.';
  end if;
  if p_difficulty not in ('facile', 'moyen', 'difficile') then raise exception 'Difficulté invalide.'; end if;

  delete from public.open_tables where last_seen < now() - interval '30 seconds';
  if (select count(*) from public.open_tables) >= 300 then
    raise exception 'Trop de tables publiques ouvertes pour le moment. Réessayez plus tard.';
  end if;
  if exists (select 1 from public.open_tables where code = p_code) then
    raise exception 'Ce code de table est déjà utilisé.';
  end if;
  insert into public.open_tables (code, host_pseudo, host_user, players, bots, difficulty)
  values (p_code, pseudo, uid, p_players, p_bots, p_difficulty)
  returning token into result;
  return result;
end;
$$;

-- Mise à jour régulière par l'hôte (sert aussi de signe de vie)
create or replace function public.update_table(p_code text, p_token uuid, p_players integer, p_bots integer, p_difficulty text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_players is null or p_players not between 1 and 6 or p_bots is null or p_bots not between 0 and 5
     or p_players + p_bots > 6 or p_difficulty not in ('facile', 'moyen', 'difficile') then
    raise exception 'Valeurs invalides.';
  end if;
  update public.open_tables
     set players = p_players, bots = p_bots, difficulty = p_difficulty, last_seen = now()
   where code = p_code and token = p_token;
  if not found then raise exception 'Table publique introuvable.'; end if;
end;
$$;

-- Retire la table de la liste (partie lancée ou table fermée)
create or replace function public.close_table(p_code text, p_token uuid)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.open_tables where code = p_code and token = p_token;
$$;

-- Tables publiques qui ont encore de la place
create or replace function public.list_tables()
returns table (
  code        text,
  host_pseudo text,
  players     integer,
  bots        integer,
  difficulty  text,
  free_seats  integer,
  has_account boolean,
  frame       text,
  title       text,
  avatar_path text,
  created_at  timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select t.code, t.host_pseudo, t.players, t.bots, t.difficulty, 6 - t.players - t.bots,
         t.host_user is not null, p.frame, p.title, p.avatar_path, t.created_at
  from public.open_tables t
  left join public.profiles p on p.id = t.host_user
  where t.last_seen > now() - interval '30 seconds'
    and t.players + t.bots < 6
  order by t.created_at desc
  limit 50;
$$;

-- ---------------------------------------------------------------------------
-- Classement (public, même sans compte) : top N + la position du joueur connecté
--   p_sort : 'cote' (parties classées), 'jetons' ou 'victoires'
-- ---------------------------------------------------------------------------

create or replace function public.leaderboard(p_sort text default 'cote', p_limit integer default 50)
returns table (
  rank          bigint,
  pseudo        text,
  title         text,
  frame         text,
  avatar_path   text,
  rating        integer,
  chips         bigint,
  wins          integer,
  games_played  integer,
  ranked_played integer,
  ranked_wins   integer,
  is_me         boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with ranked as (
    select p.*,
           row_number() over (order by
             case when p_sort = 'jetons' then p.chips
                  when p_sort = 'victoires' then p.wins
                  else p.rating end desc,
             case when p_sort = 'victoires' then p.games_played else 0 end asc,
             p.created_at asc) as rnk
    from public.profiles p
    where case when p_sort = 'jetons' then p.games_played > 0
               when p_sort = 'victoires' then p.wins > 0
               else p.ranked_played > 0 end
  )
  select rnk, r.pseudo, r.title, r.frame, r.avatar_path, r.rating, r.chips, r.wins,
         r.games_played, r.ranked_played, r.ranked_wins, r.id = auth.uid()
  from ranked r
  where rnk <= least(greatest(coalesce(p_limit, 50), 1), 100) or r.id = auth.uid()
  order by rnk;
$$;

-- ---------------------------------------------------------------------------
-- Administration (à lancer depuis le SQL Editor de Supabase ; interdit aux joueurs)
--   Attribuer un cadre exclusif : select public.grant_frame('adresse@exemple.fr', 'couronne');
--   Le retirer                  : select public.revoke_frame('adresse@exemple.fr', 'couronne');
-- ---------------------------------------------------------------------------

create or replace function public.grant_frame(p_email text, p_frame text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  target uuid;
  name   text;
begin
  if p_frame not in ('couronne') then raise exception 'Cadre exclusif inconnu : %', p_frame; end if;
  select id into target from auth.users where lower(email) = lower(btrim(p_email));
  if target is null then raise exception 'Aucun compte avec l''adresse %', p_email; end if;
  update public.profiles
     set exclusive_frames = array(select distinct unnest(exclusive_frames || array[p_frame])),
         frame = p_frame   -- le cadre est porté tout de suite
   where id = target
  returning pseudo into name;
  if name is null then raise exception 'Ce compte n''a pas encore de profil (il doit se connecter une fois au jeu).'; end if;
  return format('Cadre « %s » attribué à %s', p_frame, name);
end;
$$;

create or replace function public.revoke_frame(p_email text, p_frame text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  target uuid;
begin
  select id into target from auth.users where lower(email) = lower(btrim(p_email));
  if target is null then raise exception 'Aucun compte avec l''adresse %', p_email; end if;
  update public.profiles
     set exclusive_frames = array_remove(exclusive_frames, p_frame),
         frame = case when frame = p_frame then 'or' else frame end
   where id = target;
  return format('Cadre « %s » retiré', p_frame);
end;
$$;

-- Conditions de déblocage des titres (mêmes règles que js/looks.js)
create or replace function public.title_unlocked(p public.profiles, p_title text)
returns boolean
language sql
immutable
as $$
  select case p_title
    when 'debutant'      then true
    when 'habitue'       then p.games_played >= 10
    when 'veteran'       then p.games_played >= 50
    when 'vainqueur'     then p.wins >= 1
    when 'requin'        then p.wins >= 10
    when 'legende'       then p.wins >= 50
    when 'main_heureuse' then p.hands_won >= 100
    when 'gros_pot'      then p.biggest_pot >= 3000
    when 'flambeur'      then p.biggest_pot >= 5000
    when 'phenix'        then p.refills >= 5
    when 'riche'         then p.chips >= 10000
    when 'magnat'        then p.chips >= 50000
    else false
  end;
$$;

-- Porter un titre (uniquement s'il est débloqué)
create or replace function public.set_title(p_title text)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  uid    uuid := auth.uid();
  me     public.profiles;
  result public.profiles;
begin
  if uid is null then raise exception 'Vous devez être connecté.'; end if;
  select * into me from public.profiles where id = uid;
  if not found then raise exception 'Profil introuvable.'; end if;
  if p_title is null or not public.title_unlocked(me, p_title) then
    raise exception 'Ce titre n''est pas encore débloqué.';
  end if;
  update public.profiles set title = p_title where id = uid returning * into result;
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
-- (ancienne version à un seul paramètre remplacée par celle-ci)
drop function if exists public.start_game(integer);
create or replace function public.start_game(p_players integer, p_match bigint default null)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  uid     uuid := auth.uid();
  buy_in  constant integer := 1000;
  game_id bigint;
  seats   integer;
begin
  if uid is null then raise exception 'Vous devez être connecté.'; end if;
  if p_players is null or p_players not between 2 and 6 then
    raise exception 'Nombre de joueurs invalide.';
  end if;
  if p_match is not null then
    -- Partie classée : il faut faire partie de cette table, une seule fois
    if not exists (select 1 from public.match_players where match_id = p_match and user_id = uid) then
      raise exception 'Vous ne faites pas partie de cette partie classée.';
    end if;
    if exists (select 1 from public.games where match_id = p_match and user_id = uid) then
      raise exception 'Cette partie classée a déjà commencé pour vous.';
    end if;
    select count(*) into seats from public.match_players where match_id = p_match;
    if p_players > seats then raise exception 'Nombre de joueurs invalide pour cette partie classée.'; end if;
    update public.matches set status = 'playing' where id = p_match and status <> 'cancelled';
  end if;
  update public.profiles
     set chips = chips - buy_in,
         -- Partie classée : 15 points retenus d'avance (perdus en cas d'abandon, rendus à la fin)
         rating = case when p_match is null then rating else greatest(0, rating - 15) end
   where id = uid and chips >= buy_in;
  if not found then
    raise exception 'Solde insuffisant : il faut 1 000 jetons pour s''asseoir à une table.';
  end if;
  insert into public.games (user_id, players, buy_in, match_id) values (uid, p_players, buy_in, p_match)
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
  mp        public.match_players;
  score     numeric;
  expected  numeric;
  delta     integer;
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

  -- Partie classée : chaque place ne peut être déclarée qu'une fois, puis calcul de la cote
  if g.match_id is not null then
    if exists (select 1 from public.games
               where match_id = g.match_id and id <> g.id and finished_at is not null and place = p_place) then
      raise exception 'Cette place a déjà été déclarée par un autre joueur de la partie.';
    end if;
    select * into mp from public.match_players where match_id = g.match_id and user_id = uid;
    -- Score : 1 pour le gagnant, 0 pour le dernier ; attendu selon l'écart de cote (Elo)
    score := (g.players - p_place)::numeric / greatest(1, g.players - 1);
    expected := 1 / (1 + power(10, (mp.opponents_avg - mp.rating_before)::numeric / 400));
    delta := round(40 * (score - expected));
  end if;

  update public.games
     set finished_at = now(), final_chips = p_final_chips, place = p_place, rating_delta = delta
   where id = g.id;

  update public.profiles
     set chips         = chips + p_final_chips,
         games_played  = games_played + 1,
         wins          = wins + case when p_place = 1 then 1 else 0 end,
         best_place    = least(coalesce(best_place, p_place), p_place),
         hands_won     = hands_won + p_hands_won,
         biggest_pot   = greatest(biggest_pot, p_biggest_pot),
         rating        = case when delta is null then rating else greatest(0, rating + 15 + delta) end,
         ranked_played = ranked_played + case when delta is null then 0 else 1 end,
         ranked_wins   = ranked_wins + case when delta is not null and p_place = 1 then 1 else 0 end
   where id = uid
  returning * into result;
  return result;
end;
$$;

-- Bonus horaire : 250 jetons, une fois par heure
create or replace function public.bonus_wait()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  -- Secondes avant le prochain bonus (0 = disponible), d'après l'horloge du serveur
  select greatest(0, ceil(extract(epoch from (p.last_bonus_at + interval '1 hour') - now())))::integer
  from public.profiles p where p.id = auth.uid();
$$;

create or replace function public.claim_bonus()
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  uid    uuid := auth.uid();
  me     public.profiles;
  result public.profiles;
  wait   integer;
begin
  if uid is null then raise exception 'Vous devez être connecté.'; end if;
  select * into me from public.profiles where id = uid for update;
  if not found then raise exception 'Profil introuvable.'; end if;
  if me.last_bonus_at is not null and me.last_bonus_at > now() - interval '1 hour' then
    wait := ceil(extract(epoch from (me.last_bonus_at + interval '1 hour') - now()) / 60);
    raise exception 'Prochain bonus dans % min.', wait;
  end if;
  update public.profiles set chips = chips + 250, last_bonus_at = now()
   where id = uid returning * into result;
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
revoke all on function public.buy_frame(text) from public;
revoke all on function public.claim_bonus() from public;
revoke all on function public.bonus_wait() from public;
revoke all on function public.set_avatar(text) from public;
revoke all on function public.set_title(text) from public;
revoke all on function public.grant_frame(text, text) from public, anon, authenticated;
revoke all on function public.revoke_frame(text, text) from public, anon, authenticated;
revoke all on function public.start_game(integer, bigint) from public;
revoke all on function public.account_verified(uuid) from public, anon, authenticated;
revoke all on function public.current_match(uuid) from public, anon, authenticated;
revoke all on function public.join_queue() from public;
revoke all on function public.leave_queue() from public;
revoke all on function public.poll_queue() from public;
revoke all on function public.set_match_code(bigint, text) from public;
revoke all on function public.cancel_match(bigint) from public;
revoke all on function public.leaderboard(text, integer) from public;
revoke all on function public.open_table(text, text, integer, integer, text) from public;
revoke all on function public.update_table(text, uuid, integer, integer, text) from public;
revoke all on function public.close_table(text, uuid) from public;
revoke all on function public.list_tables() from public;
revoke all on function public.finish_game(bigint, bigint, integer, integer, bigint) from public;
revoke all on function public.refill_chips() from public;

grant execute on function public.pseudo_available(text) to anon, authenticated;
grant execute on function public.ensure_profile() to authenticated;
grant execute on function public.set_pseudo(text) to authenticated;
grant execute on function public.set_frame(text) to authenticated;
grant execute on function public.buy_frame(text) to authenticated;
grant execute on function public.claim_bonus() to authenticated;
grant execute on function public.bonus_wait() to authenticated;
grant execute on function public.set_avatar(text) to authenticated;
grant execute on function public.set_title(text) to authenticated;
grant execute on function public.start_game(integer, bigint) to authenticated;
grant execute on function public.join_queue() to authenticated;
grant execute on function public.leave_queue() to authenticated;
grant execute on function public.poll_queue() to authenticated;
grant execute on function public.set_match_code(bigint, text) to authenticated;
grant execute on function public.cancel_match(bigint) to authenticated;
grant execute on function public.leaderboard(text, integer) to anon, authenticated;
grant execute on function public.open_table(text, text, integer, integer, text) to anon, authenticated;
grant execute on function public.update_table(text, uuid, integer, integer, text) to anon, authenticated;
grant execute on function public.close_table(text, uuid) to anon, authenticated;
grant execute on function public.list_tables() to anon, authenticated;
grant execute on function public.finish_game(bigint, bigint, integer, integer, bigint) to authenticated;
grant execute on function public.refill_chips() to authenticated;
