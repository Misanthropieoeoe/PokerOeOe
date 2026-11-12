/**
 * accountUi.js — Écrans liés aux comptes : barre de compte sur l'accueil,
 * connexion / inscription / mot de passe oublié, « Mon profil », et
 * enregistrement des parties (mise, jetons récupérés, statistiques).
 *
 * Utilise Poker.Account (account.js). Sans configuration Supabase, tout le
 * monde joue en invité et ces écrans l'indiquent simplement.
 */
(function (root) {
  'use strict';

  const Poker = root.Poker;
  const Account = Poker.Account;
  const { PHASE } = Poker;
  const fmt = Poker.formatChips;

  const BUY_IN = 1000;

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function cleanPseudo(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 14);
  }

  function isEmail(text) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
  }

  function ordinal(place) {
    return place === 1 ? '1re' : `${place}e`;
  }

  class AccountUI {
    /** @param {PokerApp} app application principale (ui.js) */
    constructor(app) {
      this.app = app;
      const byId = (id) => document.getElementById(id);
      this.el = {
        bar: byId('account-bar'),
        nameInput: byId('input-name'),
        nameHint: byId('name-hint'),
        authSubtitle: byId('auth-subtitle'),
        authTabs: byId('auth-tabs'),
        forms: {
          login: byId('form-login'),
          signup: byId('form-signup'),
          forgot: byId('form-forgot'),
          newpass: byId('form-newpass'),
        },
        authError: byId('auth-error'),
        authSuccess: byId('auth-success'),
        btnGuest: byId('btn-auth-guest'),
        profileAvatar: byId('profile-avatar'),
        profileTitle: byId('profile-title'),
        profileEmail: byId('profile-email'),
        profileChips: byId('profile-chips'),
        btnRefill: byId('btn-refill'),
        refillHint: byId('profile-refill-hint'),
        stats: byId('profile-stats'),
        pseudoInput: byId('profile-pseudo'),
        profileError: byId('profile-error'),
        profileSuccess: byId('profile-success'),
        endAccount: byId('end-account'),
      };
      this.current = null; // partie en cours enregistrée sur le compte
      this.bindEvents();
      Account.onChange((event) => this.onAccountChange(event));
      this.refresh();
      Account.ready.then(() => {
        this.refresh();
        if (Account.recovery) this.openAuth('newpass');
      });
    }

    /* ---------------------------------------------------------------- */
    /* Événements                                                        */
    /* ---------------------------------------------------------------- */

    bindEvents() {
      const { el } = this;

      // Boutons de la barre de compte (délégation : son contenu est redessiné)
      el.bar.addEventListener('click', (event) => {
        const button = event.target.closest('[data-act]');
        if (!button) return;
        if (button.dataset.act === 'profile') this.openProfile();
        else this.openAuth(button.dataset.act);
      });

      el.authTabs.addEventListener('change', (event) => this.showAuthForm(event.target.value));
      document.getElementById('btn-forgot').addEventListener('click', () => this.showAuthForm('forgot'));
      document.getElementById('btn-back-login').addEventListener('click', () => this.showAuthForm('login'));
      el.btnGuest.addEventListener('click', () => this.app.showScreen('home'));

      el.forms.login.addEventListener('submit', (event) => {
        event.preventDefault();
        const email = document.getElementById('login-email').value.trim();
        const password = document.getElementById('login-password').value;
        if (!isEmail(email)) return this.authMessage('Entrez une adresse e-mail valide.');
        if (!password) return this.authMessage('Entrez votre mot de passe.');
        this.runAuth(el.forms.login, 'Connexion…', async () => {
          await Account.signIn(email, password);
          document.getElementById('login-password').value = '';
          this.app.showScreen('home');
        });
      });

      el.forms.signup.addEventListener('submit', (event) => {
        event.preventDefault();
        const pseudo = cleanPseudo(document.getElementById('signup-pseudo').value);
        const email = document.getElementById('signup-email').value.trim();
        const password = document.getElementById('signup-password').value;
        if (pseudo.length < 2) return this.authMessage('Le pseudo doit faire entre 2 et 14 caractères.');
        if (!isEmail(email)) return this.authMessage('Entrez une adresse e-mail valide.');
        if (password.length < 6) return this.authMessage('Le mot de passe doit contenir au moins 6 caractères.');
        this.runAuth(el.forms.signup, 'Création du compte…', async () => {
          const { needsConfirmation } = await Account.signUp(email, password, pseudo);
          document.getElementById('signup-password').value = '';
          if (needsConfirmation) {
            document.getElementById('login-email').value = email;
            this.showAuthForm('login');
            this.authMessage(`Compte créé ! Cliquez sur le lien envoyé à ${email} pour l’activer, puis connectez-vous.`, true);
          } else {
            this.app.showScreen('home');
          }
        });
      });

      el.forms.forgot.addEventListener('submit', (event) => {
        event.preventDefault();
        const email = document.getElementById('forgot-email').value.trim();
        if (!isEmail(email)) return this.authMessage('Entrez une adresse e-mail valide.');
        this.runAuth(el.forms.forgot, 'Envoi…', async () => {
          await Account.sendPasswordReset(email);
          this.authMessage(`Si un compte existe pour ${email}, un e-mail vient d’être envoyé avec un lien pour choisir un nouveau mot de passe.`, true);
        });
      });

      el.forms.newpass.addEventListener('submit', (event) => {
        event.preventDefault();
        const password = document.getElementById('newpass-password').value;
        if (password.length < 6) return this.authMessage('Le mot de passe doit contenir au moins 6 caractères.');
        this.runAuth(el.forms.newpass, 'Enregistrement…', async () => {
          await Account.updatePassword(password);
          document.getElementById('newpass-password').value = '';
          this.app.showScreen('home');
          this.app.setHomeError('');
        });
      });

      // Profil
      el.btnRefill.addEventListener('click', () => {
        this.runProfile(async () => {
          await Account.refill();
          return 'Votre solde est revenu à 1 000 jetons.';
        });
      });
      document.getElementById('form-pseudo').addEventListener('submit', (event) => {
        event.preventDefault();
        const pseudo = cleanPseudo(el.pseudoInput.value);
        if (pseudo.length < 2) return this.profileMessage('Le pseudo doit faire entre 2 et 14 caractères.');
        this.runProfile(async () => {
          await Account.setPseudo(pseudo);
          return 'Pseudo modifié.';
        });
      });
      document.getElementById('btn-profile-back').addEventListener('click', () => this.app.showScreen('home'));
      document.getElementById('btn-signout').addEventListener('click', () => {
        this.runProfile(async () => {
          await Account.signOut();
          this.app.showScreen('home');
        });
      });
    }

    onAccountChange(event) {
      this.refresh();
      if (event === 'PASSWORD_RECOVERY') this.openAuth('newpass');
      if (this.app.activeScreen === 'profile') {
        if (Account.signedIn) this.renderProfile();
        else this.app.showScreen('home');
      }
    }

    /** Met à jour tout ce qui dépend du compte sur l'accueil. */
    refresh() {
      this.renderBar();
      this.applyToHome();
    }

    /* ---------------------------------------------------------------- */
    /* Accueil                                                           */
    /* ---------------------------------------------------------------- */

    renderBar() {
      const { bar } = this.el;
      if (Account.signedIn) {
        const p = Account.profile;
        bar.innerHTML =
          `<span class="avatar me" aria-hidden="true">${escapeHtml(p.pseudo.charAt(0).toUpperCase())}</span>` +
          `<span class="account-status"><strong>${escapeHtml(p.pseudo)}</strong><span>${fmt(p.chips)} jetons</span></span>` +
          '<button type="button" class="btn btn-ghost btn-small" data-act="profile">Mon profil</button>';
      } else if (Account.user) {
        bar.innerHTML = '<span class="account-status">Chargement de votre profil…</span>';
      } else {
        bar.innerHTML =
          '<span class="account-status">Vous jouez en <strong>invité</strong> : rien n’est enregistré.</span>' +
          '<span class="account-buttons">' +
          '<button type="button" class="btn btn-ghost btn-small" data-act="login">Se connecter</button>' +
          '<button type="button" class="btn btn-ghost btn-small" data-act="signup">Créer un compte</button></span>';
      }
    }

    /** Connecté : le pseudo du compte est imposé et la mise est rappelée. */
    applyToHome() {
      const { nameInput, nameHint } = this.el;
      if (Account.signedIn) {
        const p = Account.profile;
        nameInput.value = p.pseudo;
        nameInput.readOnly = true;
        nameHint.textContent = `Pseudo de votre compte · chaque partie coûte une mise de 1 000 jetons (solde : ${fmt(p.chips)}).`;
      } else {
        nameInput.readOnly = false;
        nameHint.textContent = Account.configured ? 'En invité, choisissez un pseudo qui n’appartient pas à un compte.' : '';
      }
    }

    /** Pseudo à utiliser pour jouer. */
    effectiveName(typedName) {
      return Account.signedIn ? Account.profile.pseudo : typedName;
    }

    /**
     * Vérifications avant de s'asseoir à une table.
     * @returns {Promise<string|null>} message d'erreur, ou null si tout va bien
     */
    async checkBeforePlay(name) {
      if (Account.signedIn) {
        const chips = Account.profile.chips;
        if (chips < BUY_IN) {
          return `Solde insuffisant (${fmt(chips)} jetons) : il faut 1 000 jetons pour jouer avec votre compte. ` +
            'Rechargez-le gratuitement depuis « Mon profil ».';
        }
        return null;
      }
      if (Account.configured && !(await Account.isPseudoAvailable(name))) {
        return `Le pseudo « ${name} » appartient à un compte. Connectez-vous, ou choisissez un autre pseudo.`;
      }
      return null;
    }

    /* ---------------------------------------------------------------- */
    /* Connexion / inscription                                           */
    /* ---------------------------------------------------------------- */

    openAuth(form) {
      this.clearAuthMessages();
      this.showAuthForm(form || 'login');
      if (!Account.configured) {
        this.authMessage('Les comptes ne sont pas encore activés sur ce site (configuration Supabase manquante dans js/config.js). Vous pouvez jouer en invité.');
      } else if (Account.unavailable) {
        this.authMessage(Account.unavailable);
      }
      this.app.showScreen('auth');
      const first = this.el.forms[form || 'login'].querySelector('input');
      if (first) setTimeout(() => first.focus(), 50);
    }

    showAuthForm(name) {
      const { el } = this;
      Object.entries(el.forms).forEach(([key, form]) => { form.hidden = key !== name; });
      el.authTabs.hidden = name === 'forgot' || name === 'newpass';
      const tab = el.authTabs.querySelector(`input[value="${name}"]`);
      if (tab) tab.checked = true;
      el.btnGuest.hidden = name === 'newpass';
      el.authSubtitle.textContent = name === 'newpass'
        ? 'Choisissez votre nouveau mot de passe.'
        : 'Un compte garde votre pseudo, vos statistiques et votre solde de jetons fictifs.';
      this.clearAuthMessages();
    }

    clearAuthMessages() {
      this.el.authError.hidden = true;
      this.el.authSuccess.hidden = true;
    }

    authMessage(text, success = false) {
      const target = success ? this.el.authSuccess : this.el.authError;
      const other = success ? this.el.authError : this.el.authSuccess;
      other.hidden = true;
      target.textContent = text;
      target.hidden = false;
    }

    /** Exécute une action d'authentification avec le bouton en état « occupé ». */
    async runAuth(form, busyLabel, task) {
      const button = form.querySelector('button[type="submit"]');
      const label = button.textContent;
      button.disabled = true;
      button.textContent = busyLabel;
      this.clearAuthMessages();
      try {
        await task();
      } catch (error) {
        this.authMessage(error.message || String(error));
      } finally {
        button.disabled = false;
        button.textContent = label;
      }
    }

    /* ---------------------------------------------------------------- */
    /* Profil                                                            */
    /* ---------------------------------------------------------------- */

    openProfile() {
      if (!Account.signedIn) return this.openAuth('login');
      this.el.profileError.hidden = true;
      this.el.profileSuccess.hidden = true;
      this.renderProfile();
      this.app.showScreen('profile');
      // Valeurs à jour (une partie jouée sur un autre appareil, par exemple)
      Account.refreshProfile().then(() => this.renderProfile()).catch(() => {});
    }

    renderProfile() {
      const { el } = this;
      const p = Account.profile;
      if (!p) return;
      el.profileAvatar.textContent = p.pseudo.charAt(0).toUpperCase();
      el.profileTitle.textContent = p.pseudo;
      el.profileEmail.textContent = Account.user ? Account.user.email : '';
      el.profileChips.textContent = fmt(p.chips);
      if (document.activeElement !== el.pseudoInput) el.pseudoInput.value = p.pseudo;

      const canRefill = p.chips < BUY_IN;
      el.btnRefill.hidden = !canRefill;
      el.refillHint.textContent = canRefill
        ? 'Votre solde est sous la mise de 1 000 jetons : rechargez-le gratuitement pour rejouer.'
        : 'Chaque partie coûte une mise de 1 000 jetons ; vous récupérez vos jetons restants à la fin. Quitter en cours de partie fait perdre la mise.';

      const winRate = p.games_played ? Math.round((100 * p.wins) / p.games_played) : 0;
      const since = p.created_at ? new Date(p.created_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';
      const stats = [
        ['Parties jouées', fmt(p.games_played)],
        ['Victoires', p.games_played ? `${fmt(p.wins)} (${winRate} %)` : '0'],
        ['Meilleure place', p.best_place ? ordinal(p.best_place) : '—'],
        ['Mains gagnées', fmt(p.hands_won)],
        ['Plus gros pot', fmt(p.biggest_pot)],
        ['Recharges', fmt(p.refills)],
        ['Membre depuis', since],
      ];
      el.stats.innerHTML = stats.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('');
    }

    profileMessage(text, success = false) {
      const target = success ? this.el.profileSuccess : this.el.profileError;
      const other = success ? this.el.profileError : this.el.profileSuccess;
      other.hidden = true;
      target.textContent = text;
      target.hidden = false;
    }

    async runProfile(task) {
      this.el.profileError.hidden = true;
      this.el.profileSuccess.hidden = true;
      try {
        const message = await task();
        if (message) this.profileMessage(message, true);
        this.renderProfile();
      } catch (error) {
        this.profileMessage(error.message || String(error));
      }
    }

    /* ---------------------------------------------------------------- */
    /* Enregistrement des parties                                        */
    /* ---------------------------------------------------------------- */

    /** Une partie commence : la mise est prélevée sur le compte (si connecté). */
    beginGame(players) {
      if (!Account.signedIn) {
        this.current = null;
        return;
      }
      const game = { handsWon: 0, biggestPot: 0, countedHand: -1, finished: false, outcome: '' };
      game.idPromise = Account.startGame(players).catch((error) => {
        this.app.appendLog({ text: `Compte : ${error.message} Cette partie ne sera pas enregistrée.`, kind: 'elim' });
        return null;
      });
      this.current = game;
    }

    /** Abandon (retour à l'accueil) : la mise déjà prélevée est perdue. */
    abandon() {
      this.current = null;
    }

    /** Suit la partie à chaque vue : mains gagnées, plus gros pot, fin de partie. */
    trackView(view) {
      const game = this.current;
      if (!game || game.finished) return;
      const me = view.players[view.viewerId];
      if (!me) return;

      if (view.phase === PHASE.HAND_OVER && game.countedHand !== view.handNumber) {
        game.countedHand = view.handNumber;
        if (me.wonAmount > 0) {
          game.handsWon++;
          game.biggestPot = Math.max(game.biggestPot, me.wonAmount);
        }
      }

      const over = me.eliminated || (view.gameOver && view.phase === PHASE.HAND_OVER);
      if (!over) return;
      game.finished = true;
      const rank = view.ranking.find((r) => r.id === me.id);
      const place = rank ? rank.place : view.players.length;
      const finalChips = me.eliminated ? 0 : me.chips;
      game.outcome = 'Enregistrement de la partie sur votre compte…';

      game.idPromise
        .then((id) => {
          if (!id) {
            game.outcome = 'Cette partie n’a pas été enregistrée sur votre compte.';
            return null;
          }
          return Account.finishGame({ id, finalChips, place, handsWon: game.handsWon, biggestPot: game.biggestPot })
            .then((profile) => {
              const delta = finalChips - BUY_IN;
              game.outcome = `Compte : ${delta >= 0 ? '+' : '−'}${fmt(Math.abs(delta))} jetons · nouveau solde ${fmt(profile.chips)} jetons.`;
            });
        })
        .catch((error) => {
          game.outcome = `Compte : ${error.message}`;
        })
        .then(() => this.renderEndLine());
    }

    /** Ligne « Compte : +X jetons » sur l'écran de fin. */
    renderEndLine() {
      const game = this.current;
      const text = game && game.finished ? game.outcome : '';
      this.el.endAccount.textContent = text;
      this.el.endAccount.hidden = !text;
    }
  }

  Poker.AccountUI = AccountUI;
})(typeof window !== 'undefined' ? window : globalThis);
