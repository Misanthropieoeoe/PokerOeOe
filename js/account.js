/**
 * account.js — Comptes joueurs (e-mail + mot de passe) via Supabase.
 *
 * - Invité : aucun compte, rien n'est enregistré (fonctionne sans Internet).
 * - Compte : pseudo réservé, statistiques et solde de jetons fictifs conservés.
 *
 * Toutes les écritures passent par les fonctions SQL de supabase/schema.sql
 * (start_game, finish_game, refill_chips, set_pseudo), qui vérifient les montants.
 * La bibliothèque Supabase (js/vendor/supabase.js) n'est chargée que si
 * js/config.js est renseigné.
 */
(function (root) {
  'use strict';

  const Poker = (root.Poker = root.Poker || {});

  const BUY_IN = 1000;
  const LIBRARY_SRC = 'js/vendor/supabase.js';

  /** Messages d'erreur Supabase (en anglais) → français. */
  const ERROR_TRANSLATIONS = [
    [/could not find the function|function .* does not exist|schema cache/i, 'La base de données n’est pas à jour : exécutez à nouveau supabase/schema.sql dans Supabase.'],
    [/relation .* does not exist|could not find the table/i, 'La base de données n’est pas installée : exécutez supabase/schema.sql dans Supabase.'],
    [/permission denied/i, 'Accès refusé à la base de données : exécutez à nouveau supabase/schema.sql dans Supabase.'],
    [/invalid login credentials/i, 'E-mail ou mot de passe incorrect.'],
    [/email not confirmed/i, 'Confirmez d’abord votre adresse e-mail grâce au lien reçu par mail.'],
    [/already registered|already been registered|user already exists/i, 'Un compte existe déjà avec cette adresse e-mail.'],
    [/password should be at least|weak password|password is too weak|password.*(short|characters)/i, 'Mot de passe trop faible : au moins 6 caractères.'],
    [/same password|should be different/i, 'Le nouveau mot de passe doit être différent de l’ancien.'],
    [/rate limit|too many requests|security purposes/i, 'Trop de tentatives. Réessayez dans quelques minutes.'],
    [/invalid email|unable to validate email|email address .*invalid/i, 'Adresse e-mail invalide.'],
    [/signups? not allowed|signup is disabled/i, 'Les inscriptions sont fermées sur ce site.'],
    [/failed to fetch|networkerror|network request failed|load failed/i, 'Impossible de joindre le serveur des comptes. Vérifiez votre connexion.'],
    [/jwt|session.*(missing|expired)|not authenticated/i, 'Votre session a expiré : reconnectez-vous.'],
  ];

  function translateError(error) {
    const message = (error && (error.message || error.error_description || error.msg)) || String(error || '');
    for (const [pattern, french] of ERROR_TRANSLATIONS) {
      if (pattern.test(message)) return french;
    }
    return message || 'Erreur inconnue.';
  }

  let libraryPromise = null;

  function loadLibrary() {
    if (root.supabase && root.supabase.createClient) return Promise.resolve();
    if (!libraryPromise) {
      libraryPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = LIBRARY_SRC;
        script.onload = () => (root.supabase ? resolve() : reject(new Error('Module des comptes indisponible.')));
        script.onerror = () => {
          libraryPromise = null;
          reject(new Error('Impossible de charger le module des comptes.'));
        };
        document.head.appendChild(script);
      });
    }
    return libraryPromise;
  }

  class AccountService {
    constructor() {
      const config = Poker.config || {};
      this.configured = !!(config.supabaseUrl && config.supabaseAnonKey);
      this.client = null;
      this.user = null;          // utilisateur Supabase connecté
      this.profile = null;       // ligne de la table profiles
      this.recovery = false;     // vrai après un clic sur le lien « mot de passe oublié »
      this.profileError = '';    // échec du chargement du profil (affiché avec « Réessayer »)
      this.unavailable = '';     // raison si le service ne répond pas
      this.listeners = [];
      this.ready = this.configured ? this.init(config) : Promise.resolve();
    }

    get BUY_IN() { return BUY_IN; }

    /** Connecté avec un profil chargé ? */
    get signedIn() {
      return !!(this.user && this.profile);
    }

    async init(config) {
      try {
        await loadLibrary();
      } catch (error) {
        this.unavailable = error.message;
        return;
      }
      this.client = root.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      });
      this.client.auth.onAuthStateChange((event, session) => {
        if (event === 'PASSWORD_RECOVERY') this.recovery = true;
        // Différé : appeler Supabase directement dans ce rappel peut le bloquer.
        setTimeout(() => this.setUser(session ? session.user : null, event), 0);
      });
      try {
        const { data } = await this.client.auth.getSession();
        await this.setUser(data && data.session ? data.session.user : null, 'INITIAL_SESSION');
      } catch (error) {
        this.unavailable = translateError(error);
      }
    }

    async setUser(user, event) {
      const changed = (user && user.id) !== (this.user && this.user.id);
      this.user = user || null;
      if (!this.user) {
        this.profile = null;
        this.profileError = '';
      } else if (changed || !this.profile) {
        await this.loadProfile();
      }
      this.emit(event);
    }

    /** Charge le profil sans jamais lever d'erreur : en cas d'échec, profileError est renseigné. */
    async loadProfile() {
      this.profileError = '';
      try {
        await this.refreshProfile();
      } catch (error) {
        this.profile = null;
        this.profileError = error.message || String(error);
      }
    }

    /** Nouvel essai après un échec (bouton « Réessayer »). */
    async retryProfile() {
      await this.loadProfile();
      this.emit('PROFILE');
    }

    async refreshProfile() {
      if (!this.user) return null;
      const timeout = new Promise((resolve, reject) => {
        setTimeout(() => reject(new Error('Le serveur des comptes ne répond pas. Réessayez.')), 15000);
      });
      const load = async () => {
        const { data, error } = await this.client.from('profiles').select('*').eq('id', this.user.id).maybeSingle();
        if (error) throw new Error(translateError(error));
        // Compte créé avant l'installation de la base : le profil est créé maintenant.
        return data || this.rpc('ensure_profile');
      };
      const profile = await Promise.race([load(), timeout]);
      if (!profile) throw new Error('Profil introuvable : exécutez à nouveau supabase/schema.sql dans Supabase.');
      this.profile = profile;
      return profile;
    }

    onChange(listener) {
      this.listeners.push(listener);
    }

    emit(event) {
      this.listeners.forEach((fn) => fn(event));
    }

    requireClient() {
      if (!this.configured) throw new Error('Les comptes ne sont pas encore activés sur ce site.');
      if (!this.client) throw new Error(this.unavailable || 'Le service des comptes ne répond pas.');
      return this.client;
    }

    /** Adresse où revenir après un clic dans un e-mail (confirmation, mot de passe oublié). */
    redirectUrl() {
      return root.location.href.split('#')[0].split('?')[0];
    }

    async rpc(name, args) {
      const { data, error } = await this.requireClient().rpc(name, args || {});
      if (error) throw new Error(translateError(error));
      return data;
    }

    /* ---------------------------------------------------------------- */
    /* Authentification                                                  */
    /* ---------------------------------------------------------------- */

    /** @returns {Promise<{needsConfirmation:boolean}>} */
    async signUp(email, password, pseudo) {
      const client = this.requireClient();
      if (!(await this.isPseudoAvailable(pseudo))) throw new Error('Ce pseudo est déjà pris.');
      const { data, error } = await client.auth.signUp({
        email,
        password,
        options: { data: { pseudo }, emailRedirectTo: this.redirectUrl() },
      });
      if (error) throw new Error(translateError(error));
      // Avec la confirmation par e-mail activée, une adresse déjà inscrite renvoie un utilisateur sans identité.
      if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        throw new Error('Un compte existe déjà avec cette adresse e-mail.');
      }
      return { needsConfirmation: !data.session };
    }

    async signIn(email, password) {
      const { data, error } = await this.requireClient().auth.signInWithPassword({ email, password });
      if (error) throw new Error(translateError(error));
      await this.setUser(data.user, 'SIGNED_IN');
    }

    async signOut() {
      if (this.client) await this.client.auth.signOut();
      this.recovery = false;
      await this.setUser(null, 'SIGNED_OUT');
    }

    async sendPasswordReset(email) {
      const { error } = await this.requireClient().auth.resetPasswordForEmail(email, { redirectTo: this.redirectUrl() });
      if (error) throw new Error(translateError(error));
    }

    async updatePassword(password) {
      const { error } = await this.requireClient().auth.updateUser({ password });
      if (error) throw new Error(translateError(error));
      this.recovery = false;
      this.emit('PASSWORD_UPDATED');
    }

    /* ---------------------------------------------------------------- */
    /* Profil et jetons                                                  */
    /* ---------------------------------------------------------------- */

    /** Le pseudo est-il libre ? (en cas de panne du service, on ne bloque pas le joueur) */
    async isPseudoAvailable(pseudo) {
      if (!this.client) return true;
      try {
        return (await this.rpc('pseudo_available', { p_pseudo: pseudo })) !== false;
      } catch (error) {
        return true;
      }
    }

    async setPseudo(pseudo) {
      this.profile = await this.rpc('set_pseudo', { p_pseudo: pseudo });
      this.emit('PROFILE');
      return this.profile;
    }

    async refill() {
      this.profile = await this.rpc('refill_chips');
      this.emit('PROFILE');
      return this.profile;
    }

    /** Début de partie : prélève la mise. @returns {Promise<number>} identifiant de la partie */
    async startGame(players) {
      const id = await this.rpc('start_game', { p_players: players });
      if (this.profile) this.profile = Object.assign({}, this.profile, { chips: this.profile.chips - BUY_IN });
      this.emit('PROFILE');
      return id;
    }

    /** Fin de partie : rend les jetons restants et met à jour les statistiques. */
    async finishGame({ id, finalChips, place, handsWon, biggestPot }) {
      this.profile = await this.rpc('finish_game', {
        p_game: id,
        p_final_chips: finalChips,
        p_place: place,
        p_hands_won: handsWon,
        p_biggest_pot: biggestPot,
      });
      this.emit('PROFILE');
      return this.profile;
    }
  }

  Poker.Account = new AccountService();
  Poker.AccountErrors = { translateError };
})(typeof window !== 'undefined' ? window : globalThis);
