/**
 * session.js — Déroulement d'une partie (solo ou hôte d'une table en ligne).
 *
 * GameRunner fait tourner le moteur (game.js) main après main et demande à
 * chaque siège son action :
 *   - 'bot'    : Poker.Bot.decide, après un délai de réflexion de 0,8 à 1,5 s ;
 *   - 'local'  : le joueur de cet appareil (boutons de l'interface) ;
 *   - 'remote' : un joueur connecté (message réseau), avec un temps limité.
 *
 * Après chaque changement, il « publie » la vue de chaque joueur : l'interface
 * locale la dessine, et chaque joueur distant reçoit uniquement la sienne
 * (ses propres cartes, jamais celles des autres avant l'abattage).
 */
(function (root) {
  'use strict';

  const Poker = (root.Poker = root.Poker || {});
  const { PHASE, Bot } = Poker;

  const ACTION_TYPES = ['fold', 'check', 'call', 'raise', 'allin'];

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  class GameRunner {
    /**
     * @param {PokerGame} game
     * @param {Object} options
     * @param {string} options.difficulty niveau des bots
     * @param {number} [options.speed=1] multiplicateur des délais (tests)
     * @param {number} [options.localId=0] siège du joueur de cet appareil
     * @param {boolean} [options.multiplayer=false] table en ligne
     * @param {number} [options.turnTimeMs=40000] temps par tour en ligne
     * @param {number} [options.nextHandDelayMs=8000] pause entre deux mains en ligne
     * @param {Object} options.hooks
     *   onLocalView(view)                  dessiner la vue locale
     *   askLocalAction(legal) → Promise   attendre le clic du joueur local
     *   cancelLocalAction()                retirer les boutons (temps écoulé)
     *   askLocalNext(label) → Promise     bouton « Main suivante »
     *   cancelLocalNext()                  retirer ce bouton
     *   sendTo(seatId, message)            envoyer un message à un joueur distant
     *   onLog(entry)                       nouvelle ligne d'historique
     */
    constructor(game, options) {
      this.game = game;
      this.difficulty = options.difficulty;
      this.speed = options.speed || 1;
      this.localId = options.localId != null ? options.localId : 0;
      this.multiplayer = !!options.multiplayer;
      this.turnTimeMs = options.turnTimeMs || 40000;
      this.nextHandDelayMs = options.nextHandDelayMs || 8000;
      this.hooks = options.hooks;
      this.stopped = false;
      this.waiting = null;       // { id, seat, legal, deadline } pendant l'attente d'un humain
      this.turnCounter = 0;
      this.remoteResolver = null;
      this.nextDeadline = null;
      game.on((entry) => this.hooks.onLog(entry));
    }

    stop() {
      this.stopped = true;
      if (this.remoteResolver) this.remoteResolver(null);
    }

    /* ---------------------------------------------------------------- */
    /* Boucle principale                                                 */
    /* ---------------------------------------------------------------- */

    async run() {
      const game = this.game;
      while (!this.stopped && !game.isGameOver()) {
        await this.playHand();
        if (this.stopped || game.isGameOver()) break;
        await this.betweenHands();
      }
      if (!this.stopped) this.publish();
    }

    async playHand() {
      const game = this.game;
      game.startHand();
      this.publish();
      await sleep(600 * this.speed);

      while (!this.stopped && game.phase !== PHASE.HAND_OVER) {
        if (game.roundComplete) {
          // Pause entre les rues, plus longue quand on déroule le tableau après un tapis
          await sleep((game.allInRunout ? 1400 : 800) * this.speed);
          if (this.stopped) return;
          game.advance();
          this.publish();
          continue;
        }
        const player = game.currentPlayer();
        const action = await this.getAction(player);
        if (this.stopped) return;
        game.act(player.id, action);
        this.publish();
      }
    }

    /** Entre deux mains : bouton en solo ; compte à rebours en ligne (l'hôte peut le passer). */
    async betweenHands() {
      if (!this.multiplayer) {
        await this.hooks.askLocalNext('Main suivante');
        return;
      }
      this.nextDeadline = Date.now() + this.nextHandDelayMs;
      this.publish();
      await Promise.race([sleep(this.nextHandDelayMs), this.hooks.askLocalNext('Lancer la main suivante')]);
      this.hooks.cancelLocalNext();
      this.nextDeadline = null;
    }

    /* ---------------------------------------------------------------- */
    /* Actions                                                           */
    /* ---------------------------------------------------------------- */

    async getAction(player) {
      const game = this.game;

      if (player.kind === 'bot') {
        const started = Date.now();
        this.publish();
        const action = Bot.decide(game, player, this.difficulty);
        const thinking = (800 + Math.random() * 700) * this.speed;
        await sleep(Math.max(0, thinking - (Date.now() - started)));
        return action;
      }

      const legal = game.getLegalActions(player.id);
      const fallback = legal.canCheck ? { type: 'check' } : { type: 'fold' };

      // Joueur déconnecté : il checke ou se couche automatiquement.
      if (player.kind === 'remote' && !player.connected) {
        this.publish();
        await sleep(900 * this.speed);
        return fallback;
      }

      const deadline = this.multiplayer ? Date.now() + this.turnTimeMs : null;
      this.waiting = { id: ++this.turnCounter, seat: player.id, legal, deadline };
      this.publish();

      let timer = null;
      const timeout = new Promise((resolve) => {
        if (deadline) timer = setTimeout(() => resolve(null), this.turnTimeMs);
      });
      const answer = player.kind === 'local'
        ? this.hooks.askLocalAction(legal)
        : new Promise((resolve) => { this.remoteResolver = resolve; });

      const action = await Promise.race([answer, timeout]);
      clearTimeout(timer);
      this.waiting = null;
      this.remoteResolver = null;

      if (!action) {
        if (player.kind === 'local') this.hooks.cancelLocalAction();
        // (une déconnexion est déjà annoncée par setConnected)
        if (!this.stopped && player.connected) game.log(`${player.name} n’a pas joué à temps`, 'info');
        return fallback;
      }
      return action;
    }

    /** Action reçue d'un joueur distant (ignorée si ce n'est pas son tour). */
    receiveRemoteAction(seatId, message) {
      if (!this.waiting || this.waiting.seat !== seatId || message.turnId !== this.waiting.id) return;
      const action = message.action || {};
      if (!ACTION_TYPES.includes(action.type)) return;
      if (this.remoteResolver) this.remoteResolver({ type: action.type, amount: Number(action.amount) || 0 });
    }

    /** Un joueur distant se déconnecte ou revient. */
    setConnected(seatId, connected) {
      const player = this.game.players[seatId];
      if (!player || player.connected === connected) return;
      player.connected = connected;
      this.game.log(connected ? `${player.name} est de retour` : `${player.name} s’est déconnecté`, 'info');
      if (!connected && this.waiting && this.waiting.seat === seatId && this.remoteResolver) {
        this.remoteResolver(null);
      }
      this.publish();
    }

    /* ---------------------------------------------------------------- */
    /* Publication des vues                                              */
    /* ---------------------------------------------------------------- */

    viewFor(seatId) {
      const now = Date.now();
      const view = this.game.buildView(seatId);
      view.multiplayer = this.multiplayer;
      view.turn = this.waiting
        ? { id: this.waiting.id, seat: this.waiting.seat, remainingMs: this.waiting.deadline ? this.waiting.deadline - now : null }
        : null;
      view.legal = this.waiting && this.waiting.seat === seatId ? this.waiting.legal : null;
      view.nextInMs = this.nextDeadline ? Math.max(0, this.nextDeadline - now) : null;
      return view;
    }

    publish() {
      if (this.stopped) return;
      this.hooks.onLocalView(this.viewFor(this.localId));
      for (const player of this.game.players) {
        if (player.kind === 'remote' && player.connected) {
          this.hooks.sendTo(player.id, { t: 'state', view: this.viewFor(player.id) });
        }
      }
    }
  }

  Poker.GameRunner = GameRunner;
})(typeof window !== 'undefined' ? window : globalThis);
