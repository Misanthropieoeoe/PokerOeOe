/**
 * deck.js — Cartes et paquet de 52 cartes.
 *
 * Une carte est un objet immuable { rank, suit, id } :
 *   - rank : valeur de 2 à 14 (11 = Valet, 12 = Dame, 13 = Roi, 14 = As)
 *   - suit : 's' (pique), 'h' (cœur), 'd' (carreau), 'c' (trèfle)
 *   - id   : identifiant unique, ex. "14h" pour l'As de cœur
 *
 * Tous les modules s'enregistrent dans un unique espace de noms `Poker`
 * (aucune autre variable globale), ce qui permet d'ouvrir le site
 * directement depuis le disque (file://), sans serveur ni modules ES.
 */
(function (root) {
  'use strict';

  const Poker = (root.Poker = root.Poker || {});

  const SUITS = ['s', 'h', 'd', 'c'];
  const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

  const SUIT_SYMBOLS = { s: '♠', h: '♥', d: '♦', c: '♣' };
  const SUIT_NAMES = { s: 'pique', h: 'cœur', d: 'carreau', c: 'trèfle' };

  /** Libellés affichés sur les cartes (notation française : V, D, R, A). */
  const RANK_LABELS = {
    2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
    11: 'V', 12: 'D', 13: 'R', 14: 'A',
  };

  /** Noms complets (pour l'accessibilité). */
  const RANK_NAMES = {
    2: 'Deux', 3: 'Trois', 4: 'Quatre', 5: 'Cinq', 6: 'Six', 7: 'Sept', 8: 'Huit',
    9: 'Neuf', 10: 'Dix', 11: 'Valet', 12: 'Dame', 13: 'Roi', 14: 'As',
  };

  /** Notation anglaise compacte utilisée dans les tests : "As", "Td", "9c"... */
  const NOTATION_RANKS = {
    2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, T: 10, 10: 10,
    J: 11, Q: 12, K: 13, A: 14,
  };

  function createCard(rank, suit) {
    return Object.freeze({ rank, suit, id: rank + suit });
  }

  /**
   * Convertit une notation texte en carte : "Ah" → As de cœur, "Td" ou "10d" → Dix de carreau.
   */
  function parseCard(text) {
    const str = String(text).trim();
    const suit = str.slice(-1).toLowerCase();
    const rank = NOTATION_RANKS[str.slice(0, -1).toUpperCase()];
    if (!rank || !SUITS.includes(suit)) {
      throw new Error('Carte invalide : ' + text);
    }
    return createCard(rank, suit);
  }

  /** "Ah Kd 7c" → tableau de cartes. */
  function parseCards(text) {
    return String(text).trim().split(/\s+/).map(parseCard);
  }

  /** Libellé court, ex. "A♥". */
  function cardLabel(card) {
    return RANK_LABELS[card.rank] + SUIT_SYMBOLS[card.suit];
  }

  /** Nom complet, ex. "As de cœur". */
  function cardName(card) {
    return RANK_NAMES[card.rank] + ' de ' + SUIT_NAMES[card.suit];
  }

  function isRed(card) {
    return card.suit === 'h' || card.suit === 'd';
  }

  /** Entier aléatoire dans [0, max[ — utilise crypto quand il est disponible. */
  function randomInt(max) {
    const cryptoApi = root.crypto;
    if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
      const buffer = new Uint32Array(1);
      cryptoApi.getRandomValues(buffer);
      return buffer[0] % max;
    }
    return Math.floor(Math.random() * max);
  }

  /** Mélange de Fisher-Yates (en place). Retourne le tableau. */
  function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      const tmp = array[i];
      array[i] = array[j];
      array[j] = tmp;
    }
    return array;
  }

  /** Les 52 cartes dans l'ordre. */
  function fullDeck() {
    const cards = [];
    for (const suit of SUITS) {
      for (const rank of RANKS) cards.push(createCard(rank, suit));
    }
    return cards;
  }

  /** Paquet mélangé dont on tire les cartes une à une. */
  class Deck {
    /**
     * @param {Array} [presetOrder] ordre imposé (la 1re carte du tableau est tirée en premier) — utile pour les tests.
     */
    constructor(presetOrder) {
      this.cards = presetOrder ? presetOrder.slice().reverse() : shuffle(fullDeck());
    }

    draw() {
      if (this.cards.length === 0) throw new Error('Le paquet est vide');
      return this.cards.pop();
    }

    get remaining() {
      return this.cards.length;
    }
  }

  Poker.Cards = Object.freeze({
    SUITS, RANKS, SUIT_SYMBOLS, SUIT_NAMES, RANK_LABELS, RANK_NAMES,
    createCard, parseCard, parseCards, cardLabel, cardName, isRed,
    shuffle, fullDeck, randomInt, Deck,
  });
})(typeof window !== 'undefined' ? window : globalThis);
