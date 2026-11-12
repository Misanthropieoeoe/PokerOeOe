/**
 * config.js — Configuration des comptes joueurs (Supabase).
 *
 * Renseignez ici l'URL et la clé publique (« anon » / « publishable ») de votre
 * projet Supabase : Project Settings → API (ou Data API). Cette clé est faite
 * pour être publique : la sécurité repose sur les règles de supabase/schema.sql.
 *
 * Laissés vides, les comptes sont désactivés et tout le monde joue en invité.
 */
(function (root) {
  'use strict';

  const Poker = (root.Poker = root.Poker || {});

  Poker.config = Object.freeze({
    supabaseUrl: 'https://jlyxljewxmgiyioefsqi.supabase.co',
    supabaseAnonKey: 'sb_publishable_q5S2wlKkU2x03aEV-jRImg_drYZujJu',
  });
})(typeof window !== 'undefined' ? window : globalThis);
