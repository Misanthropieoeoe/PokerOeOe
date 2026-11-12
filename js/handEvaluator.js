/**
 * handEvaluator.js — Évaluation des mains de poker.
 *
 * Deux évaluateurs sont fournis :
 *   - evaluateHand(cards) : examine les 21 combinaisons de 5 cartes parmi 7
 *     et renvoie la meilleure, avec son nom en français et les 5 cartes qui
 *     la composent (utilisé pour l'abattage et l'affichage) ;
 *   - fastScore(cards)    : renvoie directement un score numérique, beaucoup
 *     plus rapide (utilisé par les bots pour leurs simulations Monte-Carlo).
 *     Les tests vérifient que les deux donnent toujours le même résultat.
 *
 * Un « score » est un tableau [catégorie, v1, v2, ...] comparé
 * lexicographiquement : la catégorie d'abord, puis les valeurs de départage
 * (rang du brelan, de la paire, kickers...).
 */
(function (root) {
  'use strict';

  const Poker = (root.Poker = root.Poker || {});

  const CATEGORY = Object.freeze({
    HIGH_CARD: 0,
    PAIR: 1,
    TWO_PAIR: 2,
    THREE_OF_A_KIND: 3,
    STRAIGHT: 4,
    FLUSH: 5,
    FULL_HOUSE: 6,
    FOUR_OF_A_KIND: 7,
    STRAIGHT_FLUSH: 8,
    ROYAL_FLUSH: 9,
  });

  const CATEGORY_NAMES = [
    'Carte haute', 'Paire', 'Double paire', 'Brelan', 'Quinte',
    'Couleur', 'Full', 'Carré', 'Quinte flush', 'Quinte flush royale',
  ];

  const RANK_PLURAL = {
    2: 'Deux', 3: 'Trois', 4: 'Quatre', 5: 'Cinq', 6: 'Six', 7: 'Sept', 8: 'Huit',
    9: 'Neuf', 10: 'Dix', 11: 'Valets', 12: 'Dames', 13: 'Rois', 14: 'As',
  };
  const RANK_SINGULAR = {
    2: 'Deux', 3: 'Trois', 4: 'Quatre', 5: 'Cinq', 6: 'Six', 7: 'Sept', 8: 'Huit',
    9: 'Neuf', 10: 'Dix', 11: 'Valet', 12: 'Dame', 13: 'Roi', 14: 'As',
  };

  /** "de Rois" / "d'As" */
  function rankDe(rank) {
    return rank === 14 ? "d'As" : 'de ' + RANK_PLURAL[rank];
  }

  /** Nom lisible d'une main, ex. "Full aux Rois par les Sept". */
  function describeHand(category, values) {
    switch (category) {
      case CATEGORY.ROYAL_FLUSH: return 'Quinte flush royale';
      case CATEGORY.STRAIGHT_FLUSH: return 'Quinte flush hauteur ' + RANK_SINGULAR[values[0]];
      case CATEGORY.FOUR_OF_A_KIND: return 'Carré ' + rankDe(values[0]);
      case CATEGORY.FULL_HOUSE: return 'Full aux ' + RANK_PLURAL[values[0]] + ' par les ' + RANK_PLURAL[values[1]];
      case CATEGORY.FLUSH: return 'Couleur hauteur ' + RANK_SINGULAR[values[0]];
      case CATEGORY.STRAIGHT: return 'Quinte hauteur ' + RANK_SINGULAR[values[0]];
      case CATEGORY.THREE_OF_A_KIND: return 'Brelan ' + rankDe(values[0]);
      case CATEGORY.TWO_PAIR: return 'Double paire ' + RANK_PLURAL[values[0]] + ' et ' + RANK_PLURAL[values[1]];
      case CATEGORY.PAIR: return 'Paire ' + rankDe(values[0]);
      default: return 'Carte haute ' + RANK_SINGULAR[values[0]];
    }
  }

  /** Compare deux scores. > 0 si a est meilleur, < 0 si b est meilleur, 0 en cas d'égalité. */
  function compareScores(a, b) {
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const diff = (a[i] || 0) - (b[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }

  /** Évalue exactement 5 cartes. */
  function evaluate5(cards) {
    const ranks = cards.map((c) => c.rank).sort((a, b) => b - a);

    // Regroupement par valeur : [[rang, nombre], ...] trié par nombre puis par rang.
    const counts = {};
    for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
    const groups = Object.keys(counts)
      .map((r) => [Number(r), counts[r]])
      .sort((a, b) => b[1] - a[1] || b[0] - a[0]);

    const isFlush = cards.every((c) => c.suit === cards[0].suit);

    // Quinte : 5 valeurs distinctes consécutives, ou la « roue » A-2-3-4-5 (hauteur 5).
    let straightHigh = 0;
    if (groups.length === 5) {
      if (ranks[0] - ranks[4] === 4) straightHigh = ranks[0];
      else if (ranks[0] === 14 && ranks[1] === 5) straightHigh = 5;
    }

    let category;
    let values;
    if (straightHigh && isFlush) {
      category = straightHigh === 14 ? CATEGORY.ROYAL_FLUSH : CATEGORY.STRAIGHT_FLUSH;
      values = [straightHigh];
    } else if (groups[0][1] === 4) {
      category = CATEGORY.FOUR_OF_A_KIND;
      values = [groups[0][0], groups[1][0]];
    } else if (groups[0][1] === 3 && groups[1][1] === 2) {
      category = CATEGORY.FULL_HOUSE;
      values = [groups[0][0], groups[1][0]];
    } else if (isFlush) {
      category = CATEGORY.FLUSH;
      values = ranks;
    } else if (straightHigh) {
      category = CATEGORY.STRAIGHT;
      values = [straightHigh];
    } else if (groups[0][1] === 3) {
      category = CATEGORY.THREE_OF_A_KIND;
      values = [groups[0][0], groups[1][0], groups[2][0]];
    } else if (groups[0][1] === 2 && groups[1][1] === 2) {
      category = CATEGORY.TWO_PAIR;
      values = [groups[0][0], groups[1][0], groups[2][0]];
    } else if (groups[0][1] === 2) {
      category = CATEGORY.PAIR;
      values = [groups[0][0], groups[1][0], groups[2][0], groups[3][0]];
    } else {
      category = CATEGORY.HIGH_CARD;
      values = ranks;
    }
    return { category, score: [category].concat(values), cards: cards.slice() };
  }

  /**
   * Meilleure main de 5 cartes parmi 5 à 7 cartes.
   * @returns {{category:number, categoryName:string, name:string, score:number[], cards:Array}}
   */
  function evaluateHand(cards) {
    if (!Array.isArray(cards) || cards.length < 5 || cards.length > 7) {
      throw new Error('evaluateHand attend entre 5 et 7 cartes');
    }
    const n = cards.length;
    let best = null;
    for (let a = 0; a < n - 4; a++) {
      for (let b = a + 1; b < n - 3; b++) {
        for (let c = b + 1; c < n - 2; c++) {
          for (let d = c + 1; d < n - 1; d++) {
            for (let e = d + 1; e < n; e++) {
              const hand = evaluate5([cards[a], cards[b], cards[c], cards[d], cards[e]]);
              if (!best || compareScores(hand.score, best.score) > 0) best = hand;
            }
          }
        }
      }
    }
    best.categoryName = CATEGORY_NAMES[best.category];
    best.name = describeHand(best.category, best.score.slice(1));
    return best;
  }

  /** Compare deux résultats de evaluateHand. */
  function compareHands(a, b) {
    return compareScores(a.score, b.score);
  }

  /**
   * Indices des meilleures mains d'une liste (plusieurs en cas d'égalité).
   * @param {Array} hands résultats de evaluateHand
   */
  function findWinners(hands) {
    let winners = [];
    hands.forEach((hand, i) => {
      if (winners.length === 0) { winners = [i]; return; }
      const cmp = compareHands(hand, hands[winners[0]]);
      if (cmp > 0) winners = [i];
      else if (cmp === 0) winners.push(i);
    });
    return winners;
  }

  /** Transforme un score-tableau en un entier comparable (base 15). */
  function packScore(score) {
    let value = score[0];
    for (let i = 1; i <= 5; i++) value = value * 15 + (score[i] || 0);
    return value;
  }

  /** Plus haute quinte présente dans un masque de bits de valeurs (bit r = valeur r). */
  function straightHighFromMask(mask) {
    let m = mask;
    if (m & (1 << 14)) m |= 1 << 1; // l'As compte aussi comme 1 (roue)
    for (let high = 14; high >= 5; high--) {
      const need = 0b11111 << (high - 4);
      if ((m & need) === need) return high;
    }
    return 0;
  }

  function pack(category, values) {
    return packScore([category].concat(values));
  }

  /**
   * Évaluateur rapide (5 à 7 cartes) : renvoie un entier, plus grand = meilleure main.
   * Donne exactement packScore(evaluateHand(cards).score).
   */
  function fastScore(cards) {
    const counts = new Array(15).fill(0);
    const suitMask = { s: 0, h: 0, d: 0, c: 0 };
    const suitCount = { s: 0, h: 0, d: 0, c: 0 };
    let mask = 0;
    for (const c of cards) {
      counts[c.rank]++;
      suitMask[c.suit] |= 1 << c.rank;
      suitCount[c.suit]++;
      mask |= 1 << c.rank;
    }

    let flushSuit = null;
    for (const s in suitCount) if (suitCount[s] >= 5) flushSuit = s;

    if (flushSuit) {
      const sf = straightHighFromMask(suitMask[flushSuit]);
      if (sf) return pack(sf === 14 ? CATEGORY.ROYAL_FLUSH : CATEGORY.STRAIGHT_FLUSH, [sf]);
    }

    const quads = [];
    const trips = [];
    const pairs = [];
    const singles = [];
    for (let r = 14; r >= 2; r--) {
      if (counts[r] === 4) quads.push(r);
      else if (counts[r] === 3) trips.push(r);
      else if (counts[r] === 2) pairs.push(r);
      else if (counts[r] === 1) singles.push(r);
    }

    if (quads.length) {
      let kicker = 0;
      for (let r = 14; r >= 2; r--) if (counts[r] > 0 && r !== quads[0]) { kicker = r; break; }
      return pack(CATEGORY.FOUR_OF_A_KIND, [quads[0], kicker]);
    }
    if (trips.length && (trips.length > 1 || pairs.length)) {
      const pairRank = Math.max(trips[1] || 0, pairs[0] || 0);
      return pack(CATEGORY.FULL_HOUSE, [trips[0], pairRank]);
    }
    if (flushSuit) {
      const flushRanks = [];
      for (let r = 14; r >= 2 && flushRanks.length < 5; r--) {
        if (suitMask[flushSuit] & (1 << r)) flushRanks.push(r);
      }
      return pack(CATEGORY.FLUSH, flushRanks);
    }
    const st = straightHighFromMask(mask);
    if (st) return pack(CATEGORY.STRAIGHT, [st]);
    if (trips.length) return pack(CATEGORY.THREE_OF_A_KIND, [trips[0], singles[0], singles[1]]);
    if (pairs.length >= 2) {
      const kicker = Math.max(pairs[2] || 0, singles[0] || 0);
      return pack(CATEGORY.TWO_PAIR, [pairs[0], pairs[1], kicker]);
    }
    if (pairs.length === 1) return pack(CATEGORY.PAIR, [pairs[0], singles[0], singles[1], singles[2]]);
    return pack(CATEGORY.HIGH_CARD, singles.slice(0, 5));
  }

  Poker.HandEvaluator = Object.freeze({
    CATEGORY, CATEGORY_NAMES,
    evaluate5, evaluateHand, compareHands, compareScores, findWinners,
    describeHand, packScore, fastScore,
  });
})(typeof window !== 'undefined' ? window : globalThis);
