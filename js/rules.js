/**
 * rules.js — Fenêtre « Règles du poker » : règles du Texas Hold'em et combinaisons.
 *
 * Le texte des règles est dans index.html (élément <dialog id="rules-dialog">) ;
 * ce module ajoute les exemples de combinaisons dessinés avec les cartes du jeu
 * et gère l'ouverture / fermeture. Les exemples sont vérifiés par tests.html.
 */
(function (root) {
  'use strict';

  const Poker = (root.Poker = root.Poker || {});

  /**
   * Combinaisons de la plus forte à la plus faible.
   * cards : notation des tests (As = As de pique, Td = Dix de carreau) ;
   * core  : positions des cartes qui forment la combinaison (les autres sont des « kickers ») ;
   * odds  : probabilité de l'obtenir avec 7 cartes (vos 2 cartes + les 5 du tableau).
   */
  const EXAMPLES = [
    { category: 9, name: 'Quinte flush royale', cards: 'As Ks Qs Js Ts', core: [0, 1, 2, 3, 4], odds: '0,003 %',
      text: 'As, Roi, Dame, Valet et Dix de la même couleur. Imbattable.' },
    { category: 8, name: 'Quinte flush', cards: '9h 8h 7h 6h 5h', core: [0, 1, 2, 3, 4], odds: '0,03 %',
      text: 'Cinq cartes qui se suivent, toutes de la même couleur.' },
    { category: 7, name: 'Carré', cards: 'Qs Qh Qd Qc 7s', core: [0, 1, 2, 3], odds: '0,17 %',
      text: 'Quatre cartes de même valeur.' },
    { category: 6, name: 'Full', cards: 'Kh Ks Kd 4c 4h', core: [0, 1, 2, 3, 4], odds: '2,6 %',
      text: 'Un brelan et une paire. Ici « full aux Rois par les Quatre ».' },
    { category: 5, name: 'Couleur', cards: 'Ad Jd 8d 6d 2d', core: [0, 1, 2, 3, 4], odds: '3,0 %',
      text: 'Cinq cartes de la même couleur, pas forcément à la suite.' },
    { category: 4, name: 'Quinte', cards: 'Ts 9h 8d 7c 6s', core: [0, 1, 2, 3, 4], odds: '4,6 %',
      text: 'Cinq cartes qui se suivent, de couleurs mélangées. L’As peut être en haut (10-V-D-R-A) ou en bas (A-2-3-4-5).' },
    { category: 3, name: 'Brelan', cards: '7h 7s 7d Kc 2s', core: [0, 1, 2], odds: '4,8 %',
      text: 'Trois cartes de même valeur.' },
    { category: 2, name: 'Double paire', cards: 'Jh Js 3c 3d Ah', core: [0, 1, 2, 3], odds: '23,5 %',
      text: 'Deux paires différentes.' },
    { category: 1, name: 'Paire', cards: 'Ah As Kd 9c 4h', core: [0, 1], odds: '43,8 %',
      text: 'Deux cartes de même valeur.' },
    { category: 0, name: 'Carte haute', cards: 'Ad Js 8c 5h 3d', core: [0], odds: '17,4 %',
      text: 'Aucune combinaison : c’est la carte la plus haute qui compte, puis la suivante…' },
  ];

  function cardHtml(card, isCore) {
    const { RANK_LABELS, SUIT_SYMBOLS, isRed, cardName } = Poker.Cards;
    const rank = RANK_LABELS[card.rank];
    const suit = SUIT_SYMBOLS[card.suit];
    return `<span class="card ${isRed(card) ? 'red' : 'black'}${card.rank === 10 ? ' ten' : ''}${isCore ? '' : ' kicker'}" ` +
      `role="img" aria-label="${cardName(card)}">` +
      `<span class="c-corner"><span class="c-rank">${rank}</span><span class="c-suit-small">${suit}</span></span>` +
      `<span class="c-suit">${suit}</span></span>`;
  }

  /** Liste des combinaisons, avec les cartes d'exemple. */
  function handRanksHtml() {
    return EXAMPLES.map((ex, i) => {
      const cards = Poker.Cards.parseCards(ex.cards);
      return `<li class="hand-rank">` +
        `<div class="hand-rank-head"><span class="hand-rank-num">${i + 1}</span>` +
        `<strong>${ex.name}</strong><span class="hand-rank-odds" title="Probabilité avec 7 cartes">${ex.odds}</span></div>` +
        `<div class="hand-rank-cards">${cards.map((c, k) => cardHtml(c, ex.core.includes(k))).join('')}</div>` +
        `<p>${ex.text}</p></li>`;
    }).join('');
  }

  class RulesDialog {
    constructor() {
      this.dialog = document.getElementById('rules-dialog');
      this.list = document.getElementById('hand-ranks');
      this.tabs = this.dialog.querySelector('.rules-tabs');
      this.body = this.dialog.querySelector('.rules-body');
      this.list.innerHTML = handRanksHtml();

      document.querySelectorAll('[data-open-rules]').forEach((button) => {
        button.addEventListener('click', () => this.open(button.dataset.openRules || 'regles'));
      });
      document.getElementById('btn-rules-close').addEventListener('click', () => this.close());
      this.tabs.addEventListener('change', (event) => this.show(event.target.value));
      // Clic en dehors de la fenêtre : fermeture
      this.dialog.addEventListener('click', (event) => {
        if (event.target === this.dialog) this.close();
      });
    }

    open(tab) {
      this.show(tab);
      if (typeof this.dialog.showModal === 'function') this.dialog.showModal();
      else this.dialog.setAttribute('open', ''); // anciens navigateurs
      this.body.scrollTop = 0;
    }

    close() {
      if (typeof this.dialog.close === 'function') this.dialog.close();
      else this.dialog.removeAttribute('open');
    }

    show(tab) {
      const radio = this.tabs.querySelector(`input[value="${tab}"]`);
      if (radio) radio.checked = true;
      this.dialog.querySelectorAll('[data-rules]').forEach((section) => {
        section.hidden = section.dataset.rules !== tab;
      });
      this.body.scrollTop = 0;
    }
  }

  Poker.Rules = Object.freeze({ EXAMPLES });
  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
      if (document.getElementById('rules-dialog')) Poker.rulesDialog = new RulesDialog();
    });
  }
})(typeof window !== 'undefined' ? window : globalThis);
