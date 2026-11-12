/**
 * game.js — Moteur de jeu Texas Hold'em No Limit.
 *
 * Ce module ne touche jamais au DOM : il gère uniquement l'état de la partie
 * (joueurs, blinds, mises, side pots, abattage). L'interface (ui.js) appelle :
 *
 *   game.startHand()            nouvelle main (bouton, blinds, distribution)
 *   game.getLegalActions(id)    actions autorisées pour le joueur
 *   game.act(id, action)        applique une action { type, amount }
 *   game.advance()              quand game.roundComplete est vrai : rue suivante,
 *                               abattage ou attribution du pot
 *
 * Types d'action : 'fold', 'check', 'call', 'raise' (amount = montant TOTAL
 * de la mise du joueur sur ce tour, « relancer à »), 'allin'.
 */
(function (root) {
  'use strict';

  const Poker = (root.Poker = root.Poker || {});
  const { Deck, cardLabel } = Poker.Cards;
  const { evaluateHand, compareHands } = Poker.HandEvaluator;

  const PHASE = Object.freeze({
    IDLE: 'idle',
    PREFLOP: 'preflop',
    FLOP: 'flop',
    TURN: 'turn',
    RIVER: 'river',
    HAND_OVER: 'handover',
  });

  const PHASE_LABELS = {
    idle: '',
    preflop: 'Pré-flop',
    flop: 'Flop',
    turn: 'Turn',
    river: 'River',
    handover: 'Fin de la main',
  };

  /** Niveaux de blinds [petite, grosse] : ils augmentent régulièrement pour que la partie se termine. */
  const BLIND_LEVELS = [
    [10, 20], [15, 30], [25, 50], [50, 100], [75, 150], [100, 200], [150, 300],
    [200, 400], [300, 600], [400, 800], [500, 1000], [750, 1500], [1000, 2000],
    [1500, 3000], [2500, 5000],
  ];

  function cardsText(cards) {
    return cards.map(cardLabel).join(' ');
  }

  function fmt(n) {
    return Math.round(n).toLocaleString('fr-FR');
  }

  function sum(values) {
    return values.reduce((a, b) => a + b, 0);
  }

  class PokerGame {
    /**
     * @param {Object} options
     * @param {Array<{name:string,kind?:'local'|'remote'|'bot',isHuman?:boolean,chips?:number}>} options.players
     *        kind : 'local' = humain sur cet appareil, 'remote' = humain connecté à distance, 'bot' = IA
     * @param {number} [options.startingChips=1000]
     * @param {number} [options.handsPerLevel=10] mains par niveau de blinds
     * @param {number} [options.firstDealer] index du premier donneur (aléatoire par défaut)
     * @param {Function} [options.deckFactory] fabrique de paquet (tests)
     */
    constructor(options) {
      const { players, startingChips = 1000, handsPerLevel = 10 } = options;
      if (!players || players.length < 2) throw new Error('Il faut au moins 2 joueurs');

      this.startingChips = startingChips;
      this.handsPerLevel = handsPerLevel;
      this.deckFactory = options.deckFactory || (() => new Deck());
      this.firstDealer = options.firstDealer != null
        ? options.firstDealer
        : Math.floor(Math.random() * players.length);

      this.players = players.map((p, i) => ({
        id: i,
        name: p.name,
        kind: p.kind || (p.isHuman ? 'local' : 'bot'),
        isHuman: p.kind ? p.kind !== 'bot' : !!p.isHuman,
        connected: true,
        chips: p.chips != null ? p.chips : startingChips,
        hand: [],
        bet: 0,            // mise sur le tour d'enchères en cours
        totalBet: 0,       // total investi dans la main (sert aux side pots)
        folded: false,
        allIn: false,
        eliminated: false,
        hasActed: false,
        raiseAllowed: true, // faux si une relance incomplète (tapis court) ne rouvre pas les enchères
        lastAction: '',
        showCards: false,
        bestHand: null,
        isWinner: false,
        wonAmount: 0,
        startChips: 0,
        place: null,
        eliminatedAt: null,
      }));

      this.handNumber = 0;
      this.phase = PHASE.IDLE;
      this.deck = null;
      this.community = [];
      this.pot = 0;             // jetons déjà ramassés au centre
      this.currentBet = 0;      // mise la plus haute du tour
      this.minRaise = 0;        // taille minimale d'une relance
      this.raisesThisStreet = 0;
      this.toAct = -1;
      this.roundComplete = false;
      this.dealerIndex = -1;
      this.sbIndex = -1;
      this.bbIndex = -1;
      this.blinds = { sb: BLIND_LEVELS[0][0], bb: BLIND_LEVELS[0][1], level: 1 };
      this.results = null;
      this.allInRunout = false;
      this.history = [];
      this.listeners = [];
    }

    /* ------------------------------------------------------------------ */
    /* Utilitaires                                                         */
    /* ------------------------------------------------------------------ */

    /** Abonnement au journal de la partie (historique des actions). */
    on(listener) {
      this.listeners.push(listener);
    }

    log(text, kind = 'info') {
      const entry = { text, kind, hand: this.handNumber };
      this.history.push(entry);
      this.listeners.forEach((fn) => fn(entry));
    }

    isActive(p) { return !p.eliminated; }
    inHand(p) { return !p.eliminated && !p.folded; }
    canAct(p) { return !p.eliminated && !p.folded && !p.allIn; }

    get activePlayers() {
      return this.players.filter((p) => !p.eliminated);
    }

    get humanPlayer() {
      return this.players.find((p) => p.isHuman) || null;
    }

    /** Index du prochain joueur (dans le sens des aiguilles d'une montre) vérifiant le prédicat, ou -1. */
    nextIndex(from, predicate) {
      const n = this.players.length;
      for (let i = 1; i <= n; i++) {
        const idx = (((from + i) % n) + n) % n;
        if (predicate(this.players[idx])) return idx;
      }
      return -1;
    }

    currentPlayer() {
      return this.toAct >= 0 ? this.players[this.toAct] : null;
    }

    /** Pot total visible : jetons ramassés + mises en cours. */
    getPotTotal() {
      return this.pot + sum(this.players.map((p) => p.bet));
    }

    /** Fin de partie : un seul joueur restant, ou plus aucun humain en jeu (inutile de regarder les bots finir). */
    isGameOver() {
      if (this.activePlayers.length <= 1) return true;
      const humans = this.players.filter((p) => p.isHuman);
      return humans.length > 0 && humans.every((p) => p.eliminated);
    }

    /* ------------------------------------------------------------------ */
    /* Début de main                                                       */
    /* ------------------------------------------------------------------ */

    startHand() {
      if (this.isGameOver()) throw new Error('La partie est terminée');
      this.handNumber++;

      // Niveau de blinds
      const levelIndex = Math.min(Math.floor((this.handNumber - 1) / this.handsPerLevel), BLIND_LEVELS.length - 1);
      const [sb, bb] = BLIND_LEVELS[levelIndex];
      const levelUp = this.handNumber > 1 && levelIndex + 1 !== this.blinds.level;
      this.blinds = { sb, bb, level: levelIndex + 1 };

      // Réinitialisation
      this.deck = this.deckFactory();
      this.community = [];
      this.pot = 0;
      this.results = null;
      this.allInRunout = false;
      this.raisesThisStreet = 0;
      for (const p of this.players) {
        Object.assign(p, {
          hand: [], bet: 0, totalBet: 0, folded: p.eliminated, allIn: false,
          hasActed: false, raiseAllowed: true, lastAction: '', showCards: false,
          bestHand: null, isWinner: false, wonAmount: 0, startChips: p.chips,
        });
      }

      // Bouton : avance au prochain joueur encore en jeu
      const isActive = (p) => !p.eliminated;
      this.dealerIndex = this.handNumber === 1
        ? this.nextIndex(this.firstDealer - 1, isActive)
        : this.nextIndex(this.dealerIndex, isActive);

      // Blinds (en tête-à-tête, le donneur poste la petite blinde)
      const headsUp = this.activePlayers.length === 2;
      this.sbIndex = headsUp ? this.dealerIndex : this.nextIndex(this.dealerIndex, isActive);
      this.bbIndex = this.nextIndex(this.sbIndex, isActive);

      this.log(`Main n°${this.handNumber} — blinds ${fmt(sb)} / ${fmt(bb)}`, 'hand');
      if (levelUp) this.log(`Les blinds augmentent : niveau ${this.blinds.level}`, 'info');
      this.log(`${this.players[this.dealerIndex].name} a le bouton`, 'info');

      const sbPlayer = this.players[this.sbIndex];
      const bbPlayer = this.players[this.bbIndex];
      const sbPaid = this.postChips(sbPlayer, sb);
      sbPlayer.lastAction = `Petite blinde ${fmt(sbPaid)}`;
      this.log(`${sbPlayer.name} paie la petite blinde (${fmt(sbPaid)})`, 'action');
      const bbPaid = this.postChips(bbPlayer, bb);
      bbPlayer.lastAction = `Grosse blinde ${fmt(bbPaid)}`;
      this.log(`${bbPlayer.name} paie la grosse blinde (${fmt(bbPaid)})`, 'action');

      // La mise à suivre est toujours la grosse blinde complète, même si la BB est à tapis court.
      this.currentBet = bb;
      this.minRaise = bb;

      // Distribution : 2 cartes chacun, en commençant à gauche du bouton
      for (let round = 0; round < 2; round++) {
        let idx = this.dealerIndex;
        for (let k = 0; k < this.activePlayers.length; k++) {
          idx = this.nextIndex(idx, isActive);
          this.players[idx].hand.push(this.deck.draw());
        }
      }

      this.phase = PHASE.PREFLOP;
      this.toAct = this.nextIndex(this.bbIndex, (p) => this.needsToAct(p));
      this.roundComplete = this.toAct === -1;
    }

    /** Déplace des jetons du tapis du joueur vers sa mise. Retourne le montant réellement misé. */
    postChips(player, amount) {
      const paid = Math.max(0, Math.min(amount, player.chips));
      player.chips -= paid;
      player.bet += paid;
      player.totalBet += paid;
      if (player.chips === 0) player.allIn = true;
      return paid;
    }

    /* ------------------------------------------------------------------ */
    /* Enchères                                                            */
    /* ------------------------------------------------------------------ */

    /** Le joueur doit-il encore parler sur ce tour ? */
    needsToAct(p) {
      if (!this.canAct(p)) return false;
      if (p.bet < this.currentBet) return true;
      // Mise égalisée : il ne parle que s'il n'a pas encore agi et qu'un adversaire peut encore répondre.
      return !p.hasActed && this.players.some((o) => o !== p && this.canAct(o));
    }

    /**
     * Actions autorisées pour un joueur.
     * @returns {{toCall:number, canCheck:boolean, canCall:boolean, canRaise:boolean,
     *            minRaiseTo:number, maxRaiseTo:number, isBet:boolean, potTotal:number, currentBet:number}}
     */
    getLegalActions(playerId) {
      const p = this.players[playerId];
      const owed = Math.max(0, this.currentBet - p.bet);
      const toCall = Math.min(owed, p.chips);
      const maxRaiseTo = p.bet + p.chips;
      const othersCanAct = this.players.some((o) => o !== p && this.canAct(o));
      const canRaise = p.raiseAllowed && othersCanAct && maxRaiseTo > this.currentBet;
      const minFull = this.currentBet + this.minRaise;
      return {
        toCall,
        canCheck: owed === 0,
        canCall: owed > 0,
        canRaise,
        minRaiseTo: Math.min(minFull, maxRaiseTo),
        maxRaiseTo,
        isBet: this.currentBet === 0,
        potTotal: this.getPotTotal(),
        currentBet: this.currentBet,
      };
    }

    /**
     * Applique l'action du joueur dont c'est le tour.
     * Les actions impossibles sont converties en l'action légale la plus proche.
     */
    act(playerId, action) {
      if (this.phase === PHASE.HAND_OVER || this.phase === PHASE.IDLE || this.roundComplete || this.toAct !== playerId) {
        throw new Error("Ce n'est pas au tour de ce joueur");
      }
      const p = this.players[playerId];
      const legal = this.getLegalActions(playerId);
      let type = action.type;
      let amount = action.amount;

      if (type === 'allin') {
        if (legal.canRaise) { type = 'raise'; amount = legal.maxRaiseTo; } else type = legal.canCall ? 'call' : 'check';
      }
      if (type === 'raise' && !legal.canRaise) type = legal.canCall ? 'call' : 'check';
      if (type === 'call' && !legal.canCall) type = 'check';
      if (type === 'check' && !legal.canCheck) type = 'fold';

      switch (type) {
        case 'fold':
          p.folded = true;
          p.lastAction = 'Se couche';
          this.log(`${p.name} se couche`, 'action');
          break;

        case 'check':
          p.lastAction = 'Check';
          this.log(`${p.name} checke`, 'action');
          break;

        case 'call': {
          const paid = this.postChips(p, this.currentBet - p.bet);
          p.lastAction = p.allIn ? `Tapis ${fmt(p.bet)}` : `Suit ${fmt(paid)}`;
          this.log(p.allIn ? `${p.name} suit ${fmt(paid)} et fait tapis` : `${p.name} suit ${fmt(paid)}`, 'action');
          break;
        }

        case 'raise': {
          let target = Math.round(Number(amount) || 0);
          target = Math.max(legal.minRaiseTo, Math.min(target, legal.maxRaiseTo));
          const wasBet = this.currentBet === 0;
          this.postChips(p, target - p.bet);
          const raiseSize = target - this.currentBet;
          const fullRaise = raiseSize >= this.minRaise;
          if (fullRaise) this.minRaise = raiseSize;
          this.currentBet = target;
          this.raisesThisStreet++;

          // Les autres joueurs doivent répondre. Une relance incomplète (tapis inférieur
          // à une relance minimale) ne rouvre pas le droit de relancer à ceux qui ont déjà parlé.
          for (const o of this.players) {
            if (o === p || !this.canAct(o)) continue;
            if (fullRaise) o.raiseAllowed = true;
            else if (o.hasActed) o.raiseAllowed = false;
            o.hasActed = false;
          }

          if (p.allIn) {
            p.lastAction = `Tapis ${fmt(target)}`;
            this.log(`${p.name} fait tapis (${fmt(target)})`, 'action');
          } else if (wasBet) {
            p.lastAction = `Mise ${fmt(target)}`;
            this.log(`${p.name} mise ${fmt(target)}`, 'action');
          } else {
            p.lastAction = `Relance à ${fmt(target)}`;
            this.log(`${p.name} relance à ${fmt(target)}`, 'action');
          }
          break;
        }

        default:
          throw new Error('Action inconnue : ' + type);
      }

      p.hasActed = true;
      this._afterAction();
      return type;
    }

    _afterAction() {
      if (this.players.filter((p) => this.inHand(p)).length <= 1) {
        this.toAct = -1;
        this.roundComplete = true;
        return;
      }
      const next = this.nextIndex(this.toAct, (p) => this.needsToAct(p));
      this.toAct = next;
      this.roundComplete = next === -1;
    }

    /* ------------------------------------------------------------------ */
    /* Fin de tour d'enchères                                              */
    /* ------------------------------------------------------------------ */

    /**
     * À appeler quand roundComplete est vrai.
     * @returns {{type:'street'|'showdown'|'uncontested', phase:string}|null}
     */
    advance() {
      if (!this.roundComplete || this.phase === PHASE.HAND_OVER) return null;

      const live = this.players.filter((p) => this.inHand(p));
      this._returnUncalledBet(live.length > 1);
      this._collectBets();

      if (live.length === 1) {
        this._awardUncontested(live[0]);
        return { type: 'uncontested', phase: this.phase };
      }

      // Plus personne (ou un seul joueur) ne peut miser : on retourne les cartes et on déroule le tableau.
      if (live.filter((p) => this.canAct(p)).length < 2 && !this.allInRunout) {
        this.allInRunout = true;
        live.forEach((p) => { p.showCards = true; });
        this.log('Tapis ! Les cartes sont retournées', 'info');
        live.forEach((p) => this.log(`${p.name} : ${cardsText(p.hand)}`, 'info'));
      }

      if (this.phase === PHASE.RIVER) {
        this._showdown();
        return { type: 'showdown', phase: this.phase };
      }
      this._dealNextStreet();
      return { type: 'street', phase: this.phase };
    }

    /** Rend au plus gros miseur la partie de sa mise que personne n'a suivie. */
    _returnUncalledBet(shouldLog) {
      const sorted = this.players.filter((p) => p.bet > 0).sort((a, b) => b.bet - a.bet);
      if (sorted.length === 0) return;
      const top = sorted[0];
      const second = sorted.length > 1 ? sorted[1].bet : 0;
      const refund = top.bet - second;
      if (refund > 0) {
        top.bet -= refund;
        top.totalBet -= refund;
        top.chips += refund;
        if (top.chips > 0) top.allIn = false;
        if (shouldLog) this.log(`${fmt(refund)} non suivis sont rendus à ${top.name}`, 'info');
      }
    }

    _collectBets() {
      for (const p of this.players) {
        this.pot += p.bet;
        p.bet = 0;
      }
    }

    _dealNextStreet() {
      const next = { preflop: PHASE.FLOP, flop: PHASE.TURN, turn: PHASE.RIVER }[this.phase];
      this.phase = next;
      this.deck.draw(); // carte brûlée
      const count = next === PHASE.FLOP ? 3 : 1;
      const newCards = [];
      for (let i = 0; i < count; i++) newCards.push(this.deck.draw());
      this.community.push(...newCards);
      this.log(`${PHASE_LABELS[next]} : ${cardsText(newCards)}  (tableau : ${cardsText(this.community)})`, 'street');

      this.currentBet = 0;
      this.minRaise = this.blinds.bb;
      this.raisesThisStreet = 0;
      for (const p of this.players) {
        if (this.canAct(p)) {
          p.hasActed = false;
          p.raiseAllowed = true;
          p.lastAction = '';
        }
      }
      this.toAct = this.nextIndex(this.dealerIndex, (p) => this.needsToAct(p));
      this.roundComplete = this.toAct === -1;
    }

    /**
     * Découpe les mises en pot principal + side pots.
     * Chaque niveau de mise d'un joueur encore en lice crée une « couche » ;
     * seuls les joueurs ayant misé au moins ce niveau peuvent la gagner.
     * @param {boolean} [collectedOnly=false] ignorer les mises du tour en cours (affichage)
     * @returns {Array<{amount:number, eligible:number[]}>}
     */
    computePots(collectedOnly = false) {
      const contribution = (p) => (collectedOnly ? p.totalBet - p.bet : p.totalBet);
      const live = this.players.filter((p) => this.inHand(p));
      const levels = [...new Set(live.map(contribution).filter((v) => v > 0))].sort((a, b) => a - b);
      const pots = [];
      let previous = 0;
      for (const level of levels) {
        let amount = 0;
        for (const p of this.players) {
          amount += Math.max(0, Math.min(contribution(p), level) - previous);
        }
        const eligible = live.filter((p) => contribution(p) >= level).map((p) => p.id);
        const last = pots[pots.length - 1];
        if (amount > 0) {
          if (last && last.eligible.length === eligible.length) last.amount += amount; // même ensemble de joueurs
          else pots.push({ amount, eligible });
        }
        previous = level;
      }
      // Jetons éventuels de joueurs couchés au-delà du plus haut niveau : au dernier pot.
      const total = sum(this.players.map(contribution));
      const counted = sum(pots.map((pt) => pt.amount));
      if (pots.length && total > counted) pots[pots.length - 1].amount += total - counted;
      return pots;
    }

    _awardUncontested(winner) {
      const amount = this.pot;
      winner.chips += amount;
      winner.wonAmount = amount;
      winner.isWinner = true;
      this.pot = 0;
      this.results = {
        type: 'uncontested',
        pots: [{ label: 'Pot', amount, winners: [{ id: winner.id, amount }], handName: null }],
        highlight: new Set(),
      };
      this.log(`${winner.name} remporte ${fmt(amount)} (tous les autres se sont couchés)`, 'win');
      this._finishHand();
    }

    _showdown() {
      const n = this.players.length;
      const live = this.players.filter((p) => this.inHand(p));
      this.log('Abattage', 'street');
      for (const p of live) {
        p.showCards = true;
        p.bestHand = evaluateHand(p.hand.concat(this.community));
        this.log(`${p.name} montre ${cardsText(p.hand)} — ${p.bestHand.name}`, 'info');
      }

      // Distance depuis la gauche du bouton : le jeton indivisible va au premier gagnant après le bouton.
      const seatOrder = (p) => (p.id - this.dealerIndex - 1 + n) % n;

      const pots = this.computePots();
      const results = [];
      const highlight = new Set();
      pots.forEach((pot, index) => {
        const contenders = pot.eligible.map((id) => this.players[id]);
        let best = [];
        for (const p of contenders) {
          if (best.length === 0) { best = [p]; continue; }
          const cmp = compareHands(p.bestHand, best[0].bestHand);
          if (cmp > 0) best = [p];
          else if (cmp === 0) best.push(p);
        }
        best.sort((a, b) => seatOrder(a) - seatOrder(b));
        const share = Math.floor(pot.amount / best.length);
        let remainder = pot.amount - share * best.length;
        const winners = best.map((p) => {
          const won = share + (remainder > 0 ? 1 : 0);
          if (remainder > 0) remainder--;
          p.chips += won;
          p.wonAmount += won;
          p.isWinner = true;
          p.bestHand.cards.forEach((c) => highlight.add(c.id));
          return { id: p.id, amount: won };
        });

        const label = pots.length === 1 ? 'Pot' : index === 0 ? 'Pot principal' : `Pot annexe ${index}`;
        const handName = best[0].bestHand.name;
        results.push({ label, amount: pot.amount, winners, handName });
        if (best.length === 1) {
          this.log(`${best[0].name} remporte ${fmt(pot.amount)} (${label.toLowerCase()}) avec ${handName}`, 'win');
        } else {
          const names = best.map((p) => p.name).join(' et ');
          this.log(`Égalité : ${names} se partagent ${fmt(pot.amount)} (${label.toLowerCase()}) avec ${handName}`, 'win');
        }
      });

      this.pot = 0;
      this.results = { type: 'showdown', pots: results, highlight };
      this._finishHand();
    }

    /** Fin de main : éliminations et classement. */
    _finishHand() {
      this.phase = PHASE.HAND_OVER;
      this.toAct = -1;
      this.roundComplete = false;

      const remainingBefore = this.activePlayers.length;
      // Plusieurs éliminés sur la même main : celui qui avait le plus de jetons au départ est mieux classé.
      const busted = this.players
        .filter((p) => !p.eliminated && p.chips === 0)
        .sort((a, b) => a.startChips - b.startChips);
      busted.forEach((p, i) => {
        p.eliminated = true;
        p.place = remainingBefore - i;
        p.eliminatedAt = this.handNumber;
        p.lastAction = 'Éliminé';
        this.log(`${p.name} n’a plus de jetons et quitte la table (${p.place}e place)`, 'elim');
      });

      const active = this.activePlayers;
      if (active.length === 1) {
        active[0].place = 1;
        this.log(`${active[0].name} remporte la partie !`, 'win');
      }
    }

    /** Classement : joueurs encore en jeu (par jetons) puis éliminés (par place). */
    getRanking() {
      const alive = this.players.filter((p) => !p.eliminated).sort((a, b) => b.chips - a.chips);
      const out = this.players.filter((p) => p.eliminated).sort((a, b) => a.place - b.place);
      return alive.map((p, i) => ({ player: p, place: p.place || i + 1 }))
        .concat(out.map((p) => ({ player: p, place: p.place })));
    }

    /**
     * Vue de la table pour un joueur donné : objet JSON simple, sans aucune
     * information secrète (les cartes des adversaires n'y figurent que lorsqu'elles
     * sont retournées). C'est ce qui est affiché localement et envoyé sur le réseau.
     * @param {number} viewerId siège du joueur qui regarde (-1 = spectateur)
     */
    buildView(viewerId) {
      const results = this.results
        ? { type: this.results.type, pots: this.results.pots, highlight: Array.from(this.results.highlight) }
        : null;
      return {
        viewerId,
        handNumber: this.handNumber,
        phase: this.phase,
        blinds: Object.assign({}, this.blinds),
        dealerIndex: this.dealerIndex,
        sbIndex: this.sbIndex,
        bbIndex: this.bbIndex,
        toAct: this.toAct,
        potTotal: this.getPotTotal(),
        pots: this.phase === PHASE.HAND_OVER ? [] : this.computePots(true).map((pot) => pot.amount),
        community: this.community.slice(),
        allInRunout: this.allInRunout,
        results,
        gameOver: this.isGameOver(),
        players: this.players.map((p) => ({
          id: p.id,
          name: p.name,
          kind: p.kind,
          isHuman: p.isHuman,
          connected: p.connected,
          chips: p.chips,
          bet: p.bet,
          folded: p.folded,
          allIn: p.allIn,
          eliminated: p.eliminated,
          eliminatedAt: p.eliminatedAt,
          place: p.place,
          lastAction: p.lastAction,
          isWinner: p.isWinner,
          wonAmount: p.wonAmount,
          showCards: p.showCards,
          cardCount: p.hand.length,
          hand: p.id === viewerId || p.showCards ? p.hand.slice() : null,
          bestHandName: p.showCards && p.bestHand ? p.bestHand.name : null,
        })),
        ranking: this.getRanking().map((r) => ({ id: r.player.id, place: r.place })),
      };
    }

    /** Total des jetons en jeu (vérification de cohérence). */
    totalChips() {
      return sum(this.players.map((p) => p.chips + p.bet)) + this.pot;
    }
  }

  Poker.PHASE = PHASE;
  Poker.PHASE_LABELS = PHASE_LABELS;
  Poker.BLIND_LEVELS = BLIND_LEVELS;
  Poker.PokerGame = PokerGame;
  Poker.formatChips = fmt;
})(typeof window !== 'undefined' ? window : globalThis);
