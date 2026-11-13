/**
 * bot.js — Intelligence artificielle des adversaires.
 *
 * Chaque décision combine :
 *   - la force de la main : avant le flop, l'équité contre UNE main aléatoire
 *     (mise en cache par type de main : « AKs », « 72o »…) ; après le flop, une
 *     simulation Monte-Carlo contre les adversaires encore en jeu ;
 *   - la position (plus de mains jouées près du bouton) ;
 *   - le prix à payer (cote du pot) et la part du tapis engagée ;
 *   - la lecture des adversaires : le bot observe le journal des actions
 *     (game.actionLog) et repère les joueurs qui jouent beaucoup de mains ou font
 *     souvent tapis. Face à eux il suit plus large ; face à un joueur prudent, il se méfie ;
 *   - un peu d'aléatoire, des mises de continuation et du bluff selon le niveau.
 *
 * API : Poker.Bot.decide(game, player, difficulty) → { type, amount }
 */
(function (root) {
  'use strict';

  const Poker = (root.Poker = root.Poker || {});
  const { fullDeck } = Poker.Cards;
  const { fastScore, evaluateHand } = Poker.HandEvaluator;

  /**
   * Profils de difficulté.
   *  iterations : simulations Monte-Carlo après le flop
   *  noise      : aléatoire ajouté à l'estimation de force
   *  open       : force minimale pour ouvrir [première position, bouton] (équité contre 1 main)
   *  openRaise  : probabilité d'ouvrir en relançant (sinon en suivant)
   *  limp       : force minimale pour simplement suivre la grosse blinde (bots faciles)
   *  threeBet   : force minimale pour relancer une relance
   *  callFloor  : force minimale pour suivre une relance (en plus de la cote du pot)
   *  reads      : lecture des adversaires (0 = aucune, 1 = complète)
   *  callBias   : tendance à payer (> 0 : paie plus souvent)
   *  cbet       : probabilité de miser au flop après avoir relancé avant
   *  bluff      : fréquence des bluffs et semi-bluffs
   *  aggression : probabilité de miser / relancer pour la valeur
   *  mistake    : probabilité d'une action irréfléchie
   */
  const PROFILES = {
    facile: {
      iterations: 150, noise: 0.10, open: [0.60, 0.53], openRaise: 0.3, limp: 0.44, threeBet: 0.72, callFloor: 0.47,
      reads: 0, callBias: 0.07, cbet: 0.25, bluff: 0, aggression: 0.35, mistake: 0.06,
    },
    moyen: {
      iterations: 300, noise: 0.05, open: [0.58, 0.50], openRaise: 0.85, limp: 1, threeBet: 0.68, callFloor: 0.55,
      reads: 0.6, callBias: 0.02, cbet: 0.5, bluff: 0.04, aggression: 0.7, mistake: 0.02,
    },
    difficile: {
      iterations: 500, noise: 0.03, open: [0.57, 0.48], openRaise: 0.95, limp: 1, threeBet: 0.66, callFloor: 0.54,
      reads: 1, callBias: 0, cbet: 0.65, bluff: 0.1, aggression: 0.85, mistake: 0,
    },
  };

  const NORMAL_LOOSENESS = 0.25; // style « normal » supposé tant qu'on n'a rien observé

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  /* ------------------------------------------------------------------ */
  /* Force des mains                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Équité estimée (probabilité de gagner, égalités partagées) contre `opponents`
   * mains aléatoires, par simulation Monte-Carlo.
   */
  function estimateEquity(hole, board, opponents, iterations) {
    if (opponents <= 0) return 1;
    const known = new Set(hole.concat(board).map((c) => c.id));
    const deck = fullDeck().filter((c) => !known.has(c.id));
    const missing = 5 - board.length;
    const needed = missing + opponents * 2;
    let total = 0;
    for (let it = 0; it < iterations; it++) {
      for (let i = 0; i < needed; i++) {
        const j = i + Math.floor(Math.random() * (deck.length - i));
        const tmp = deck[i]; deck[i] = deck[j]; deck[j] = tmp;
      }
      const fullBoard = board.concat(deck.slice(0, missing));
      const heroScore = fastScore(hole.concat(fullBoard));
      let lost = false;
      let ties = 0;
      for (let o = 0; o < opponents; o++) {
        const base = missing + o * 2;
        const score = fastScore([deck[base], deck[base + 1]].concat(fullBoard));
        if (score > heroScore) { lost = true; break; }
        if (score === heroScore) ties++;
      }
      if (!lost) total += 1 / (ties + 1);
    }
    return total / iterations;
  }

  /** Type de main de départ : « AKs », « QJo », « 77 ». */
  function handKey(hole) {
    const [a, b] = hole[0].rank >= hole[1].rank ? hole : [hole[1], hole[0]];
    if (a.rank === b.rank) return `${a.rank}-${b.rank}`;
    return `${a.rank}-${b.rank}${a.suit === b.suit ? 's' : 'o'}`;
  }

  const preflopCache = new Map();

  /** Force avant le flop : équité contre une main aléatoire (≈ 0,32 pour 7-2, 0,85 pour As-As). */
  function preflopStrength(hole) {
    const key = handKey(hole);
    if (!preflopCache.has(key)) preflopCache.set(key, estimateEquity(hole, [], 1, 1200));
    return preflopCache.get(key);
  }

  /** Formule de Chen (conservée pour compatibilité). */
  function chenScore(hole) {
    const [a, b] = hole[0].rank >= hole[1].rank ? hole : [hole[1], hole[0]];
    const points = { 14: 10, 13: 8, 12: 7, 11: 6 };
    let score = points[a.rank] || a.rank / 2;
    if (a.rank === b.rank) return Math.max(5, score * 2);
    if (a.suit === b.suit) score += 2;
    const gap = a.rank - b.rank - 1;
    score -= [0, 1, 2, 4][gap] !== undefined ? [0, 1, 2, 4][gap] : 5;
    if (gap <= 1 && a.rank < 12) score += 1;
    return Math.ceil(score);
  }

  /** Estimation grossière (conservée pour compatibilité). */
  function roughEquity(hole, board, opponents) {
    const fair = 1 / (opponents + 1);
    if (board.length === 0) return Math.min(0.95, fair * (0.5 + chenScore(hole) / 8));
    const category = evaluateHand(hole.concat(board)).category;
    return Math.min(0.95, fair * [0.6, 1.25, 1.6, 2, 2.4, 2.6, 3.2, 4, 5, 5][category]);
  }

  /** Position relative : 0 = premier à parler (petite blinde), 1 = bouton. */
  function relativePosition(game, player) {
    const n = game.players.length;
    const order = game.players
      .filter((p) => !p.eliminated)
      .map((p) => p.id)
      .sort((a, b) => ((a - game.dealerIndex - 1 + n) % n) - ((b - game.dealerIndex - 1 + n) % n));
    return order.length > 1 ? order.indexOf(player.id) / (order.length - 1) : 1;
  }

  /* ------------------------------------------------------------------ */
  /* Lecture des adversaires                                             */
  /* ------------------------------------------------------------------ */

  const memories = new WeakMap(); // partie → { seen, stats: Map(id → statistiques) }

  /** Met à jour les statistiques de chaque joueur à partir du journal des actions. */
  function observe(game) {
    let memory = memories.get(game);
    if (!memory) {
      memory = { seen: 0, stats: new Map() };
      memories.set(game, memory);
    }
    const log = game.actionLog || [];
    for (; memory.seen < log.length; memory.seen++) {
      const e = log[memory.seen];
      if (!memory.stats.has(e.id)) memory.stats.set(e.id, { hands: new Set(), played: new Set(), raised: new Set(), shoved: new Set() });
      const s = memory.stats.get(e.id);
      s.hands.add(e.hand);
      if (e.phase === 'preflop' && (e.type === 'call' || e.type === 'raise')) s.played.add(e.hand);
      if (e.type === 'raise') s.raised.add(e.hand);
      if (e.allIn && e.type !== 'fold' && e.type !== 'check') s.shoved.add(e.hand);
    }
    return memory;
  }

  /**
   * Style d'un adversaire, de 0 (très prudent : ne joue que de grosses mains)
   * à 1 (joue presque tout, fait souvent tapis). Sans observations : style « normal ».
   */
  function looseness(game, playerId) {
    const s = observe(game).stats.get(playerId);
    if (!s) return NORMAL_LOOSENESS;
    const hands = s.hands.size;
    const prior = 6; // quelques mains « normales » imaginaires pour ne pas conclure trop vite
    const played = (s.played.size + prior * 0.3) / (hands + prior);
    const raised = (s.raised.size + prior * 0.12) / (hands + prior);
    const shoved = (s.shoved.size + prior * 0.03) / (hands + prior);
    return clamp((played - 0.2) / 0.6 * 0.5 + raised * 0.8 + shoved * 1.2, 0, 1);
  }

  /** Dernier joueur à avoir misé ou relancé dans cette main (à cette rue si `street`). */
  function lastAggressor(game, street) {
    const log = game.actionLog || [];
    for (let i = log.length - 1; i >= 0; i--) {
      const e = log[i];
      if (e.hand !== game.handNumber) break;
      if (street && e.phase !== street) continue;
      if (e.type === 'raise') return e.id;
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Décision                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Choisit l'action d'un bot.
   * @param {PokerGame} game
   * @param {Object} player
   * @param {'facile'|'moyen'|'difficile'} difficulty
   * @returns {{type:string, amount?:number}}
   */
  function decide(game, player, difficulty) {
    const profile = PROFILES[difficulty] || PROFILES.moyen;
    const legal = game.getLegalActions(player.id);
    const { sb, bb } = game.blinds;
    const preflop = game.phase === 'preflop';
    const pot = legal.potTotal;
    const toCall = legal.toCall;
    const stack = player.chips + player.bet;
    const opponents = game.players.filter((p) => p.id !== player.id && game.inHand(p));
    const position = relativePosition(game, player);
    const rand = Math.random;

    // --- Actions de base ---
    const check = () => ({ type: 'check' });
    const call = () => ({ type: 'call' });
    const checkOrCall = () => (legal.canCheck ? check() : call());
    const checkOrFold = () => (legal.canCheck ? check() : { type: 'fold' });
    const allIn = () => (legal.canRaise ? { type: 'allin' } : checkOrCall());
    const raiseTo = (amount) => {
      if (!legal.canRaise) return checkOrCall();
      let target = Math.round(amount / sb) * sb;
      target = clamp(target, legal.minRaiseTo, legal.maxRaiseTo);
      if (target >= legal.maxRaiseTo * 0.7) return { type: 'allin' }; // presque tout le tapis : autant faire tapis
      return { type: 'raise', amount: target };
    };
    const potBet = (fraction) => raiseTo(legal.currentBet + fraction * (pot + toCall));

    // Erreur occasionnelle (bots faciles)
    if (rand() < profile.mistake) {
      if (legal.canCheck) return check();
      return toCall < stack * 0.15 ? call() : { type: 'fold' };
    }

    // Style de l'adversaire qui a misé (lecture plus ou moins fine selon le niveau)
    const aggressor = lastAggressor(game, game.phase);
    const readLoose = aggressor !== null && aggressor !== player.id ? looseness(game, aggressor) : NORMAL_LOOSENESS;
    const loose = NORMAL_LOOSENESS + (readLoose - NORMAL_LOOSENESS) * profile.reads
      + (profile.reads === 0 ? 0.25 : 0); // les bots faciles supposent qu'on bluffe souvent

    const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;
    const commitment = toCall / Math.max(1, player.chips);

    /* ---------------- Avant le flop ---------------- */
    if (preflop) {
      const s = preflopStrength(player.hand) + (rand() - 0.5) * profile.noise;
      const active = game.players.filter((p) => !p.eliminated).length;
      // Moins de joueurs à la table : on joue plus de mains
      const shortTable = active <= 3 ? 0.03 : active === 4 ? 0.015 : 0;
      const openThr = profile.open[0] + (profile.open[1] - profile.open[0]) * position - shortTable;
      const raised = legal.currentBet > bb; // quelqu'un a déjà relancé
      const limpers = opponents.filter((p) => p.bet === legal.currentBet && p.bet > 0).length;

      // Tapis court (≤ 12 grosses blindes) : tapis ou couché
      if (stack <= bb * 12) {
        const pushThr = openThr - 0.04 - (raised ? -0.04 : 0);
        if (s >= pushThr) return allIn();
        return checkOrFold();
      }

      if (!raised) {
        // Personne n'a relancé : ouvrir, suivre la blinde ou passer
        if (s >= openThr && legal.canRaise) {
          if (rand() < profile.openRaise) return raiseTo(bb * (2.4 + rand() * 0.7) + bb * limpers);
          return checkOrCall();
        }
        if (legal.canCheck) return check();
        // Petite blinde : compléter avec une main correcte (ça coûte peu)
        const cheap = toCall <= bb / 2 + 0.01;
        if (cheap && s >= openThr - 0.06) return call();
        if (s >= profile.limp) return call(); // bots faciles : suivent souvent
        return { type: 'fold' };
      }

      // Face à une relance : on estime notre équité contre la fourchette du relanceur.
      // Joueur prudent → fourchette serrée → notre main vaut moins ; joueur large → elle vaut plus.
      const rangePenalty = 0.13 * (1 - clamp(loose / 0.9, 0, 1));
      const multiway = Math.max(0, opponents.filter((p) => p.bet > 0 && !p.folded).length - 1) * 0.03;
      const eq = s - rangePenalty - multiway;
      // Grosse main : on relance (ou tapis si la relance est déjà grosse)
      if (s >= profile.threeBet && legal.canRaise && game.raisesThisStreet < 3 && rand() < profile.aggression + 0.1) {
        if (legal.currentBet > stack * 0.25 || s >= 0.8) return allIn();
        return raiseTo(legal.currentBet * (2.6 + rand() * 0.6));
      }
      // Bluff de relance occasionnel en position (difficile)
      if (legal.canRaise && position >= 0.7 && game.raisesThisStreet === 1 && rand() < profile.bluff * 0.5 && commitment < 0.15) {
        return raiseTo(legal.currentBet * 3);
      }
      // Suivre une relance demande une main correcte (on jouera la suite sans l'initiative),
      // un peu moins contre un relanceur qui joue beaucoup de mains ou en fin de parole.
      const floor = profile.callFloor - 0.08 * clamp((loose - NORMAL_LOOSENESS) / 0.6, 0, 1) - 0.02 * position;
      const required = Math.max(potOdds + 0.04 * commitment, commitment > 0.3 ? 0 : floor) - profile.callBias;
      if (eq >= required || (commitment <= 0.3 && s >= floor && eq >= potOdds)) return call();
      return { type: 'fold' };
    }

    /* ---------------- Après le flop ---------------- */
    const nOpp = Math.max(1, opponents.length);
    let equity = estimateEquity(player.hand, game.community, nOpp, profile.iterations);
    // Face à une mise, la main adverse est en moyenne meilleure qu'une main au hasard,
    // surtout de la part d'un joueur prudent et pour une grosse mise.
    if (toCall > 0) {
      const betRatio = toCall / Math.max(1, pot - toCall);
      equity -= Math.min(0.14, 0.1 * Math.min(1.5, betRatio)) * (1 - clamp(loose / 0.9, 0, 1));
    }
    equity += (rand() - 0.5) * profile.noise + (position - 0.5) * 0.02;
    const fair = 1 / (nOpp + 1);
    const edge = (equity - fair) / (1 - fair); // > 0 : mieux que la moyenne
    const wasAggressor = lastAggressor(game, 'preflop') === player.id;
    const draw = game.phase !== 'river' && edge > -0.15 && edge < 0.12 && equity > fair * 0.85;

    if (toCall === 0) {
      // Personne n'a misé
      if (edge >= 0.35 && legal.canRaise) {
        if (edge > 0.7 && rand() < 0.15 * profile.reads) return check(); // piège : check-raise
        if (rand() < profile.aggression) return potBet(0.55 + rand() * 0.3);
        return check();
      }
      if (edge >= 0.12 && legal.canRaise && rand() < profile.aggression * 0.55) return potBet(0.4 + rand() * 0.15);
      // Mise de continuation au flop après avoir relancé avant
      if (wasAggressor && game.phase === 'flop' && nOpp <= 2 && legal.canRaise && rand() < profile.cbet) return potBet(0.5);
      // Semi-bluff sur un tirage, bluff à la river
      if (legal.canRaise && nOpp <= 2) {
        if (draw && rand() < profile.bluff * 2.5) return potBet(0.55);
        if (game.phase === 'river' && rand() < profile.bluff) return potBet(0.6 + rand() * 0.2);
      }
      return check();
    }

    // Face à une mise
    if (edge >= 0.45 && legal.canRaise && game.raisesThisStreet < 3 && rand() < profile.aggression * 0.6) {
      if (edge > 0.7 && (game.phase === 'river' || pot > player.chips * 0.5)) return allIn();
      return raiseTo(legal.currentBet * (2.5 + rand() * 0.6));
    }
    if (draw && legal.canRaise && nOpp === 1 && rand() < profile.bluff && commitment < 0.25) {
      return raiseTo(legal.currentBet * 2.8); // semi-bluff
    }
    const required = potOdds + 0.05 * commitment - profile.callBias;
    if (equity >= required) return call();
    return { type: 'fold' };
  }

  Poker.Bot = Object.freeze({
    PROFILES, decide, estimateEquity, chenScore, roughEquity, relativePosition, preflopStrength, looseness,
  });
})(typeof window !== 'undefined' ? window : globalThis);
