/**
 * bot.js — Intelligence artificielle des adversaires.
 *
 * Chaque bot estime la force de sa main puis la compare au prix à payer :
 *   - force : équité estimée par simulation Monte-Carlo (moyen / difficile)
 *     ou par une heuristique simple (facile) ;
 *   - position : un bot proche du bouton joue un peu plus large ;
 *   - taille du pot : cote du pot (pot odds) et part du tapis engagée ;
 *   - un peu d'aléatoire, et du bluff occasionnel en mode difficile.
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
   *  iterations  : simulations Monte-Carlo (0 = heuristique simple)
   *  noise       : amplitude de l'aléatoire ajouté à l'estimation
   *  aggression  : probabilité de relancer quand la main le justifie
   *  tightness   : multiplicateur des seuils (plus haut = plus sélectif)
   *  allInEdge   : avantage minimal pour pousser tapis avec une main forte
   *  looseness   : tendance à payer trop souvent
   *  mistake     : probabilité d'une action irréfléchie
   *  bluff       : fréquence de bluff
   *  readsBets   : tient compte du fait qu'une grosse mise adverse signale une main forte
   *  positional  : importance accordée à la position
   */
  const PROFILES = {
    facile: { iterations: 0, noise: 0.25, aggression: 0.35, tightness: 1, allInEdge: 0.85, looseness: 0.1, mistake: 0.1, bluff: 0, readsBets: false, positional: 0 },
    moyen: { iterations: 250, noise: 0.1, aggression: 0.75, tightness: 1, allInEdge: 0.65, looseness: 0.03, mistake: 0.02, bluff: 0, readsBets: true, positional: 0.5 },
    difficile: { iterations: 500, noise: 0.05, aggression: 0.9, tightness: 1.05, allInEdge: 0.65, looseness: 0, mistake: 0, bluff: 0.12, readsBets: true, positional: 1 },
  };

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

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
      // Mélange partiel : seules les `needed` premières cartes nous intéressent.
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

  /** Formule de Chen : force d'une main de départ (de -1 à 20). */
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

  /** Estimation grossière de l'équité (bots faciles). */
  function roughEquity(hole, board, opponents) {
    const fair = 1 / (opponents + 1);
    let multiplier;
    if (board.length === 0) {
      multiplier = 0.5 + chenScore(hole) / 8;
    } else {
      const category = evaluateHand(hole.concat(board)).category;
      multiplier = [0.6, 1.25, 1.6, 2, 2.4, 2.6, 3.2, 4, 5, 5][category];
    }
    return Math.min(0.95, fair * multiplier);
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
    const opponents = game.players.filter((p) => p.id !== player.id && game.inHand(p)).length;

    // --- Actions de base (toujours légales) ---
    const check = () => ({ type: 'check' });
    const call = () => ({ type: 'call' });
    const checkOrCall = () => (legal.canCheck ? check() : call());
    const checkOrFold = () => (legal.canCheck ? check() : { type: 'fold' });
    const allIn = () => (legal.canRaise ? { type: 'allin' } : checkOrCall());
    const raiseTo = (amount) => {
      if (!legal.canRaise) return checkOrCall();
      let target = Math.round(amount / sb) * sb; // montants « ronds »
      target = clamp(target, legal.minRaiseTo, legal.maxRaiseTo);
      // Si la relance engage presque tout le tapis, autant faire tapis.
      if (target >= legal.maxRaiseTo * 0.7) return { type: 'allin' };
      return { type: 'raise', amount: target };
    };
    /** Mise exprimée en fraction du pot (après avoir suivi). */
    const potRaise = (fraction) => raiseTo(legal.currentBet + fraction * (pot + toCall));

    // --- 1. Force de la main ---
    let equity = profile.iterations > 0
      ? estimateEquity(player.hand, game.community, opponents, profile.iterations)
      : roughEquity(player.hand, game.community, opponents);

    // Face à une grosse mise, l'adversaire a rarement une main aléatoire.
    if (toCall > 0 && profile.readsBets) {
      const betRatio = toCall / Math.max(1, pot - toCall);
      equity -= Math.min(0.15, 0.08 * betRatio);
    }

    // --- 2. Position et aléatoire ---
    const position = relativePosition(game, player);
    equity += (position - 0.5) * 0.04 * profile.positional;
    equity += (Math.random() - 0.5) * profile.noise;

    const fair = 1 / (opponents + 1);              // équité « moyenne » à cette table
    const edge = (equity - fair) / (1 - fair);     // > 0 : main meilleure que la moyenne
    const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;
    const commitment = toCall / Math.max(1, player.chips); // part du tapis à engager

    const strongThreshold = 0.3 * profile.tightness;
    const mediumThreshold = 0.08 * profile.tightness;

    // --- 3. Erreur occasionnelle (bots faciles) ---
    if (Math.random() < profile.mistake) {
      if (legal.canCheck) return check();
      return commitment < 0.25 ? call() : { type: 'fold' };
    }

    // --- 4. Tapis court : tapis ou couché ---
    const stackInBB = (player.chips + player.bet) / bb;
    if (stackInBB <= 10 && legal.canRaise && edge > 0.12 * profile.tightness) return allIn();

    // --- 5. Main forte : on relance (pour la valeur) ---
    const canKeepRaising = game.raisesThisStreet < 3 || edge > 0.55;
    if (edge >= strongThreshold && legal.canRaise && canKeepRaising && Math.random() < profile.aggression) {
      if (edge > profile.allInEdge && (game.phase === 'river' || pot > player.chips * 0.6)) return allIn();
      if (preflop) {
        const limpers = game.players.filter((p) => p.id !== player.id && game.inHand(p) && p.bet === legal.currentBet).length;
        const target = legal.currentBet <= bb
          ? bb * (2.5 + Math.random()) + bb * Math.max(0, limpers - 1)
          : legal.currentBet * (2.5 + Math.random() * 0.7);
        return raiseTo(target);
      }
      return potRaise(0.45 + edge * 0.6 + Math.random() * 0.15);
    }

    // --- 6. Personne n'a misé ---
    if (toCall === 0) {
      if (edge >= mediumThreshold && legal.canRaise && Math.random() < 0.3 * profile.aggression) {
        return preflop ? raiseTo(legal.currentBet + bb * 2) : potRaise(0.5);
      }
      // Bluff (difficile) : peu d'adversaires, après le flop.
      if (!preflop && legal.canRaise && opponents <= 2 && Math.random() < profile.bluff) {
        return potRaise(0.5 + Math.random() * 0.25);
      }
      return check();
    }

    // --- 7. Face à une mise ---
    // Vol de blindes en fin de parole (difficile).
    if (preflop && legal.canRaise && position >= 0.75 && game.raisesThisStreet === 0 && Math.random() < profile.bluff * 2) {
      return raiseTo(bb * 2.5);
    }
    // Relance-bluff rare en tête-à-tête.
    if (!preflop && legal.canRaise && opponents === 1 && Math.random() < profile.bluff * 0.25) {
      return potRaise(0.8);
    }
    const required = potOdds * (1 + 0.3 * commitment) - profile.looseness;
    if (equity >= required) return call();
    return checkOrFold();
  }

  Poker.Bot = Object.freeze({ PROFILES, decide, estimateEquity, chenScore, roughEquity, relativePosition });
})(typeof window !== 'undefined' ? window : globalThis);
