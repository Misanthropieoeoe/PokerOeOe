/**
 * ranked.js — Parties classées (matchmaking) et classement.
 *
 * Matchmaking : réservé aux comptes dont l'adresse e-mail est confirmée.
 *   1. join_queue : le joueur entre dans la file (vérifications côté serveur) ;
 *   2. poll_queue toutes les 2 s : le serveur forme une table de 2 à 6 joueurs
 *      de cote proche et désigne un hôte ;
 *   3. l'hôte crée une table en ligne (net.js) et publie son code (set_match_code),
 *      les autres la rejoignent automatiquement ; la partie démarre sans bots.
 *
 * Classement : public (même pour les invités), par cote, jetons ou victoires.
 */
(function (root) {
  'use strict';

  const Poker = root.Poker;
  const Account = Poker.Account;
  const Looks = Poker.Looks;
  const fmt = Poker.formatChips;

  const POLL_MS = 2000;
  const GUEST_WAIT_MS = 60000; // sans code de table au bout d'une minute, on relance la recherche
  const BOTS_AFTER_S = 10;     // sans table au bout de 10 s : partie contre 4 bots difficiles (décidé par le serveur)

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function duration(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  const SORT_HINTS = {
    cote: 'Cote gagnée en parties classées (1 000 au départ). Seuls les joueurs ayant joué une partie classée apparaissent.',
    jetons: 'Solde de jetons fictifs des joueurs ayant joué au moins une partie avec leur compte.',
    victoires: 'Nombre de parties gagnées (à égalité, le moins de parties jouées passe devant).',
  };

  class RankedUI {
    /** @param {PokerApp} app application principale (ui.js) */
    constructor(app) {
      this.app = app;
      const byId = (id) => document.getElementById(id);
      this.el = {
        requirements: byId('ranked-requirements'),
        queueStatus: byId('queue-status'),
        queueMeta: byId('queue-meta'),
        queuePlayers: byId('queue-players'),
        queueError: byId('queue-error'),
        lbTabs: byId('lb-tabs'),
        lbHint: byId('lb-hint'),
        lbList: byId('lb-list'),
        lbError: byId('lb-error'),
      };
      this.active = false;   // recherche en cours
      this.timer = null;
      this.busy = false;
      this.match = null;     // { id, role, players, since }
      this.lbRequest = 0;

      byId('btn-queue-cancel').addEventListener('click', () => this.cancel());
      byId('btn-leaderboard').addEventListener('click', () => this.openLeaderboard());
      byId('btn-lb-back').addEventListener('click', () => this.app.showScreen('home'));
      this.el.lbTabs.addEventListener('change', (event) => this.loadLeaderboard(event.target.value));
      Account.onChange(() => this.renderRequirements());
      Account.ready.then(() => this.renderRequirements());
      this.renderRequirements();
    }

    /* ---------------------------------------------------------------- */
    /* Conditions d'accès (onglet « Classée » de l'accueil)              */
    /* ---------------------------------------------------------------- */

    /** @returns {string|null} ce qui empêche de lancer une partie classée */
    blocker() {
      if (!Account.configured) return 'Les comptes ne sont pas activés sur ce site.';
      if (!Account.signedIn) return 'Connectez-vous avec un compte pour jouer en partie classée.';
      if (!Account.verified) return 'Confirmez votre adresse e-mail (lien reçu par mail) pour jouer en partie classée.';
      if (Account.profile.chips < Account.BUY_IN) return 'Solde insuffisant : rechargez-le depuis « Mon profil ».';
      return null;
    }

    renderRequirements() {
      const signed = Account.signedIn;
      const items = [
        [signed, 'Connecté avec un compte'],
        [signed && Account.verified, 'Adresse e-mail confirmée'],
        [signed && Account.profile.chips >= Account.BUY_IN, 'Solde d’au moins 1 000 jetons'],
      ];
      this.el.requirements.innerHTML = items.map(([okay, label]) =>
        `<li class="${okay ? 'ok' : 'missing'}"><span aria-hidden="true">${okay ? '✓' : '✗'}</span> ${label}` +
        `<span class="sr-only">${okay ? ' (rempli)' : ' (manquant)'}</span></li>`).join('') +
        (signed ? `<li class="rating-line">Votre cote : <strong>${fmt(Account.profile.rating || 1000)}</strong></li>` : '');
    }

    /* ---------------------------------------------------------------- */
    /* Recherche d'adversaires                                           */
    /* ---------------------------------------------------------------- */

    async start() {
      const problem = this.blocker();
      if (problem) {
        this.app.setHomeError(problem);
        this.app.showScreen('home');
        return;
      }
      this.stopTimer();
      this.active = true;
      this.match = null;
      this.el.queueError.hidden = true;
      this.el.queuePlayers.innerHTML = '';
      this.setStatus('Recherche d’adversaires…', '');
      this.app.showScreen('queue');
      try {
        this.handle(await Account.joinQueue());
      } catch (error) {
        this.active = false;
        this.app.setHomeError(error.message);
        this.app.showScreen('home');
        return;
      }
      this.timer = setInterval(() => this.tick(), POLL_MS);
    }

    stopTimer() {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    }

    async tick() {
      if (!this.active || this.busy) return;
      this.busy = true;
      try {
        this.handle(await Account.pollQueue());
        this.el.queueError.hidden = true;
      } catch (error) {
        this.el.queueError.textContent = `${error.message} Nouvel essai…`;
        this.el.queueError.hidden = false;
      } finally {
        this.busy = false;
      }
    }

    setStatus(text, meta) {
      this.el.queueStatus.textContent = text;
      this.el.queueMeta.textContent = meta || '';
    }

    renderPlayers(players) {
      this.el.queuePlayers.innerHTML = (players || []).map((p) =>
        `<li>${Looks.avatarHtml({ name: p.pseudo, variant: 'person' })}` +
        `<span class="lobby-name">${escapeHtml(p.pseudo)}</span><span class="tag">Cote ${fmt(p.rating)}</span></li>`).join('');
    }

    /** Réponse du serveur : en attente, table trouvée, ou plus dans la file. */
    handle(state) {
      if (!this.active || !state) return;
      if (state.status === 'waiting') {
        const others = Math.max(0, (state.waiting || 1) - 1);
        const botsIn = Math.max(0, BOTS_AFTER_S - (state.seconds || 0));
        this.setStatus('Recherche d’adversaires…',
          `${others === 0 ? 'Aucun autre joueur' : others === 1 ? '1 autre joueur' : `${others} autres joueurs`} dans la file · ${duration(state.seconds)}` +
          (botsIn > 0 ? ` · bots dans ${botsIn} s` : ' · préparation des bots…'));
        return;
      }
      if (state.status === 'idle') {
        // Sorti de la file (table annulée, longue absence) : on y retourne
        Account.joinQueue().then((s) => this.handle(s)).catch(() => {});
        return;
      }
      if (state.status !== 'matched') return;

      // Personne à temps : partie classée contre 4 bots difficiles
      if (state.bots > 0) {
        this.stopTimer();
        this.active = false;
        this.match = null;
        this.setStatus('Pas d’adversaire disponible', `Partie classée contre ${state.bots} bots difficiles…`);
        this.app.startRankedBots(state.match_id, state.bots);
        return;
      }

      if (!this.match || this.match.id !== state.match_id) {
        this.match = { id: state.match_id, role: state.role, players: state.players, since: Date.now(), started: false };
      }
      this.renderPlayers(state.players);
      const opponents = state.players.length - 1;

      if (state.role === 'host' && !this.match.started) {
        this.match.started = true;
        this.stopTimer();
        this.setStatus(`${opponents} adversaire${opponents > 1 ? 's' : ''} trouvé${opponents > 1 ? 's' : ''} !`, 'Vous êtes l’hôte : création de la table…');
        this.hostMatch(state);
      } else if (state.role === 'guest' && state.code && !this.match.started) {
        this.match.started = true;
        this.stopTimer();
        this.setStatus('Table trouvée !', 'Connexion à la table…');
        this.active = false;
        this.app.joinTable(state.code, false, { matchId: state.match_id });
      } else if (state.role === 'guest') {
        this.setStatus(`${opponents} adversaire${opponents > 1 ? 's' : ''} trouvé${opponents > 1 ? 's' : ''} !`, 'L’hôte prépare la table…');
        if (Date.now() - this.match.since > GUEST_WAIT_MS) this.restart('La table n’a pas pu être créée. Nouvelle recherche…');
      }
    }

    /** L'hôte crée la table en ligne et publie son code. */
    async hostMatch(state) {
      const code = await this.app.createTable({
        ranked: { matchId: state.match_id, players: state.players.map((p) => p.pseudo) },
      });
      if (!code) {
        Account.cancelMatch(state.match_id).catch(() => {});
        this.restart('La table n’a pas pu être créée. Nouvelle recherche…');
        return;
      }
      try {
        await Account.setMatchCode(state.match_id, code);
        this.active = false; // la salle d'attente (ui.js) prend le relais
      } catch (error) {
        this.app.leaveToHome();
        this.restart(error.message);
      }
    }

    /** Relance une recherche (après un échec), avec un message. */
    restart(message) {
      this.stopTimer();
      this.active = false;
      this.start().then(() => {
        if (message && this.app.activeScreen === 'queue') {
          this.el.queueError.textContent = message;
          this.el.queueError.hidden = false;
        }
      });
    }

    /** L'invité n'a pas pu rejoindre la table de l'hôte. */
    joinFailed(message) {
      this.restart(`${message} Nouvelle recherche…`);
    }

    cancel() {
      const match = this.match;
      this.stopTimer();
      this.active = false;
      this.match = null;
      Account.leaveQueue().catch(() => {});
      if (match && match.role === 'host') Account.cancelMatch(match.id).catch(() => {});
      this.app.showScreen('home');
    }

    /* ---------------------------------------------------------------- */
    /* Classement                                                        */
    /* ---------------------------------------------------------------- */

    openLeaderboard() {
      const checked = this.el.lbTabs.querySelector('input:checked');
      this.app.showScreen('leaderboard');
      this.loadLeaderboard(checked ? checked.value : 'cote');
    }

    async loadLeaderboard(sort) {
      const { lbList, lbError, lbHint } = this.el;
      const request = ++this.lbRequest;
      lbHint.textContent = SORT_HINTS[sort] || '';
      lbError.hidden = true;
      lbList.innerHTML = '<li class="lb-empty">Chargement…</li>';
      let rows;
      try {
        if (!Account.configured) throw new Error('Les comptes ne sont pas activés sur ce site : pas de classement.');
        await Account.ready;
        rows = await Account.leaderboard(sort);
      } catch (error) {
        if (request !== this.lbRequest) return;
        lbList.innerHTML = '';
        lbError.textContent = error.message;
        lbError.hidden = false;
        return;
      }
      if (request !== this.lbRequest) return; // un autre onglet a été choisi entre-temps
      if (!rows.length) {
        lbList.innerHTML = `<li class="lb-empty">${sort === 'cote'
          ? 'Personne n’a encore joué de partie classée. Soyez le premier !'
          : 'Aucun joueur classé pour l’instant.'}</li>`;
        return;
      }
      let previous = 0;
      lbList.innerHTML = rows.map((row) => {
        const rank = Number(row.rank);
        const gap = rank > previous + 1 && previous > 0 ? '<li class="lb-gap" aria-hidden="true">…</li>' : '';
        previous = rank;
        const look = { avatar: Account.publicAvatarUrl(row.avatar_path), frame: row.frame, title: row.title };
        const title = Looks.titleName(row.title);
        let value;
        let detail;
        if (sort === 'jetons') {
          value = fmt(row.chips);
          detail = 'jetons';
        } else if (sort === 'victoires') {
          value = fmt(row.wins);
          detail = `victoire${row.wins > 1 ? 's' : ''} · ${fmt(row.games_played)} partie${row.games_played > 1 ? 's' : ''}`;
        } else {
          value = fmt(row.rating);
          detail = `${fmt(row.ranked_played)} classée${row.ranked_played > 1 ? 's' : ''} · ${fmt(row.ranked_wins)} victoire${row.ranked_wins > 1 ? 's' : ''}`;
        }
        const medal = rank <= 3 ? ` medal-${rank}` : '';
        return gap + `<li class="lb-row${row.is_me ? ' me' : ''}">` +
          `<span class="lb-rank${medal}">${rank}</span>` +
          Looks.avatarHtml({ name: row.pseudo, look, variant: row.is_me ? 'me' : 'person' }) +
          `<span class="lb-name">${escapeHtml(row.pseudo)}${row.is_me ? ' (vous)' : ''}` +
          `${title ? `<em class="player-title">${escapeHtml(title)}</em>` : ''}</span>` +
          `<span class="lb-value"><strong>${value}</strong><small>${detail}</small></span></li>`;
      }).join('');
    }
  }

  Poker.RankedUI = RankedUI;
})(typeof window !== 'undefined' ? window : globalThis);
