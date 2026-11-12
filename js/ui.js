/**
 * ui.js — Interface graphique et déroulement de la partie.
 *
 * - PokerApp gère les trois écrans (accueil, table, fin de partie) ;
 * - la boucle asynchrone runGame() enchaîne les mains : elle attend le clic
 *   du joueur humain, ou fait réfléchir les bots avec un petit délai ;
 * - render() met à jour le DOM à partir de l'état du moteur (game.js),
 *   en ne recréant les cartes que lorsqu'elles changent (pour les animations).
 *
 * Astuce de test : ajouter « ?vitesse=rapide » à l'URL raccourcit tous les délais.
 */
(function (root) {
  'use strict';

  const Poker = root.Poker;
  const { RANK_LABELS, SUIT_SYMBOLS, isRed, cardName, shuffle } = Poker.Cards;
  const { PokerGame, PHASE, PHASE_LABELS, Bot } = Poker;
  const fmt = Poker.formatChips;

  const BOT_NAMES = ['Léa', 'Hugo', 'Chloé', 'Malik', 'Inès', 'Théo', 'Zoé', 'Karim', 'Emma', 'Lucas', 'Nora', 'Yanis'];

  const DIFFICULTY_LABELS = { facile: 'Facile', moyen: 'Moyen', difficile: 'Difficile' };
  const DIFFICULTY_HINTS = {
    facile: 'Des bots qui suivent beaucoup et ne bluffent jamais.',
    moyen: 'Des bots solides qui calculent leurs chances.',
    difficile: 'Des bots agressifs, attentifs à la position… et qui bluffent.',
  };

  const STORAGE_KEY = 'poker-holdem-reglages';

  /** Pause asynchrone. */
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function randomBetween(min, max) {
    return min + Math.random() * (max - min);
  }

  /** Crée l'élément DOM d'une carte (face visible ou dos). */
  function createCardElement(card, faceUp) {
    const el = document.createElement('div');
    if (!faceUp) {
      el.className = 'card back';
      el.setAttribute('aria-label', 'Carte cachée');
      return el;
    }
    el.className = 'card ' + (isRed(card) ? 'red' : 'black') + (card.rank === 10 ? ' ten' : '');
    el.dataset.cardId = card.id;
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', cardName(card));
    const rank = RANK_LABELS[card.rank];
    const suit = SUIT_SYMBOLS[card.suit];
    el.innerHTML =
      `<span class="c-corner"><span class="c-rank">${rank}</span><span class="c-suit-small">${suit}</span></span>` +
      `<span class="c-suit">${suit}</span>`;
    return el;
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  class PokerApp {
    constructor() {
      const byId = (id) => document.getElementById(id);
      this.el = {
        screens: { home: byId('screen-home'), game: byId('screen-game'), end: byId('screen-end') },
        form: byId('home-form'),
        nameInput: byId('input-name'),
        difficultyHint: byId('difficulty-hint'),
        infoHand: byId('info-hand'),
        infoBlinds: byId('info-blinds'),
        infoDifficulty: byId('info-difficulty'),
        tableWrap: byId('table-wrap'),
        table: byId('table'),
        pot: byId('pot'),
        potAmount: byId('pot-amount'),
        sidePots: byId('side-pots'),
        board: byId('board'),
        streetLabel: byId('street-label'),
        resultBanner: byId('result-banner'),
        status: byId('controls-status'),
        actionPanel: byId('action-panel'),
        raiseRow: byId('raise-row'),
        slider: byId('raise-slider'),
        raiseValue: byId('raise-value'),
        btnFold: byId('btn-fold'),
        btnCall: byId('btn-call'),
        btnRaise: byId('btn-raise'),
        btnAllin: byId('btn-allin'),
        nextPanel: byId('next-panel'),
        btnNext: byId('btn-next'),
        logPanel: byId('log-panel'),
        logList: byId('log-list'),
        endIcon: byId('end-icon'),
        endTitle: byId('end-title'),
        endSubtitle: byId('end-subtitle'),
        endRanking: byId('end-ranking'),
      };

      const fast = new URLSearchParams(root.location.search).get('vitesse') === 'rapide';
      this.speed = fast ? 0.05 : 1;

      this.game = null;
      this.settings = this.loadSettings();
      this.session = 0;          // incrémenté à chaque nouvelle partie : arrête l'ancienne boucle
      this.seats = [];
      this.pendingAction = null; // résolveur de l'action humaine en attente
      this.pendingNext = null;   // résolveur du bouton « Main suivante »
      this.legal = null;
      this.boardHand = -1;

      this.bindEvents();
      this.applySettingsToForm();
    }

    /* ------------------------------------------------------------------ */
    /* Réglages et écrans                                                  */
    /* ------------------------------------------------------------------ */

    loadSettings() {
      const defaults = { name: 'Joueur', bots: 4, difficulty: 'moyen' };
      try {
        const saved = JSON.parse(root.localStorage.getItem(STORAGE_KEY) || 'null');
        return Object.assign(defaults, saved || {});
      } catch (e) {
        return defaults;
      }
    }

    saveSettings() {
      try {
        root.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
      } catch (e) { /* stockage indisponible : sans importance */ }
    }

    applySettingsToForm() {
      const { form } = this.el;
      this.el.nameInput.value = this.settings.name;
      const bots = form.querySelector(`input[name="bots"][value="${this.settings.bots}"]`);
      if (bots) bots.checked = true;
      const diff = form.querySelector(`input[name="difficulty"][value="${this.settings.difficulty}"]`);
      if (diff) diff.checked = true;
      this.updateDifficultyHint();
    }

    updateDifficultyHint() {
      const checked = this.el.form.querySelector('input[name="difficulty"]:checked');
      this.el.difficultyHint.textContent = DIFFICULTY_HINTS[checked ? checked.value : 'moyen'];
    }

    showScreen(name) {
      Object.entries(this.el.screens).forEach(([key, screen]) => {
        screen.classList.toggle('active', key === name);
      });
      if (name === 'game') this.layoutTable();
    }

    bindEvents() {
      const { el } = this;

      el.form.addEventListener('change', () => this.updateDifficultyHint());
      el.form.addEventListener('submit', (event) => {
        event.preventDefault();
        const data = new FormData(el.form);
        this.settings = {
          name: (el.nameInput.value || '').trim().slice(0, 14) || 'Joueur',
          bots: Number(data.get('bots')) || 4,
          difficulty: data.get('difficulty') || 'moyen',
        };
        this.saveSettings();
        this.startGame();
      });

      // Actions du joueur
      el.btnFold.addEventListener('click', () => this.submitAction({ type: 'fold' }));
      el.btnCall.addEventListener('click', () => {
        if (!this.legal) return;
        this.submitAction({ type: this.legal.canCheck ? 'check' : 'call' });
      });
      el.btnRaise.addEventListener('click', () => this.submitAction({ type: 'raise', amount: Number(el.slider.value) }));
      el.btnAllin.addEventListener('click', () => this.submitAction({ type: 'allin' }));

      // Curseur de relance et raccourcis
      el.slider.addEventListener('input', () => this.updateRaiseLabel());
      document.getElementById('raise-minus').addEventListener('click', () => this.stepRaise(-1));
      document.getElementById('raise-plus').addEventListener('click', () => this.stepRaise(1));
      el.actionPanel.querySelectorAll('[data-preset]').forEach((btn) => {
        btn.addEventListener('click', () => this.applyPreset(btn.dataset.preset));
      });

      el.btnNext.addEventListener('click', () => {
        if (this.pendingNext) this.pendingNext();
      });

      // Historique (tiroir sur mobile)
      document.getElementById('btn-log').addEventListener('click', () => el.logPanel.classList.toggle('open'));
      document.getElementById('btn-log-close').addEventListener('click', () => el.logPanel.classList.remove('open'));

      // Quitter : confirmation en deux clics, dans la page (les boîtes confirm() peuvent être bloquées)
      const btnQuit = document.getElementById('btn-quit');
      let quitTimer = null;
      btnQuit.addEventListener('click', () => {
        if (btnQuit.classList.contains('confirm')) {
          clearTimeout(quitTimer);
          btnQuit.classList.remove('confirm');
          btnQuit.textContent = 'Quitter';
          this.quitToHome();
          return;
        }
        btnQuit.classList.add('confirm');
        btnQuit.textContent = 'Confirmer ?';
        quitTimer = setTimeout(() => {
          btnQuit.classList.remove('confirm');
          btnQuit.textContent = 'Quitter';
        }, 3000);
      });
      document.getElementById('btn-replay').addEventListener('click', () => this.startGame());
      document.getElementById('btn-settings').addEventListener('click', () => this.quitToHome());

      // Raccourcis clavier : F = se coucher, C = checker/suivre, R = relancer, Entrée = main suivante
      document.addEventListener('keydown', (event) => {
        if (!el.screens.game.classList.contains('active') || event.target.tagName === 'INPUT' && event.target.type === 'text') return;
        const key = event.key.toLowerCase();
        if (this.pendingAction) {
          if (key === 'f') el.btnFold.click();
          else if (key === 'c') el.btnCall.click();
          else if (key === 'r' && !el.btnRaise.hidden) el.btnRaise.click();
        } else if (this.pendingNext && (key === 'enter' || key === ' ')) {
          event.preventDefault();
          el.btnNext.click();
        }
      });

      root.addEventListener('resize', () => this.layoutTable());
    }

    /** Annule toute attente en cours (action du joueur, bouton « Main suivante »). */
    resetPrompts() {
      this.pendingAction = null;
      this.pendingNext = null;
      this.legal = null;
      this.el.actionPanel.hidden = true;
      this.el.nextPanel.hidden = true;
    }

    quitToHome() {
      this.session++;
      this.resetPrompts();
      this.applySettingsToForm();
      this.showScreen('home');
    }

    /* ------------------------------------------------------------------ */
    /* Partie                                                              */
    /* ------------------------------------------------------------------ */

    startGame() {
      this.session++;
      this.resetPrompts();
      const session = this.session;
      const { name, bots, difficulty } = this.settings;

      const botNames = shuffle(BOT_NAMES.filter((n) => n.toLowerCase() !== name.toLowerCase())).slice(0, bots);
      const players = [{ name, isHuman: true }].concat(botNames.map((n) => ({ name: n })));
      this.game = new PokerGame({ players, startingChips: 1000, handsPerLevel: 10 });
      this.game.on((entry) => this.appendLog(entry));

      this.el.logList.innerHTML = '';
      this.el.infoDifficulty.textContent = DIFFICULTY_LABELS[difficulty];
      this.el.logPanel.classList.remove('open');
      this.boardHand = -1;
      this.buildSeats();
      this.showScreen('game');
      this.runGame(session);
    }

    isCurrent(session) {
      return session === this.session;
    }

    async runGame(session) {
      const game = this.game;
      while (this.isCurrent(session) && !game.isGameOver()) {
        await this.playHand(session);
        if (!this.isCurrent(session)) return;
        const over = game.isGameOver();
        await this.waitForNext(over ? 'Voir le classement' : 'Main suivante');
        if (!this.isCurrent(session)) return;
      }
      if (this.isCurrent(session)) this.showEndScreen();
    }

    async playHand(session) {
      const game = this.game;
      game.startHand();
      this.render();
      await sleep(600 * this.speed);

      while (this.isCurrent(session) && game.phase !== PHASE.HAND_OVER) {
        if (game.roundComplete) {
          // Pause entre les rues (plus longue quand on déroule le tableau après un tapis)
          await sleep((game.allInRunout ? 1400 : 800) * this.speed);
          if (!this.isCurrent(session)) return;
          game.advance();
          this.render();
          continue;
        }

        const player = game.currentPlayer();
        this.render();
        let action;
        if (player.isHuman) {
          action = await this.askHuman();
        } else {
          const started = Date.now();
          action = Bot.decide(game, player, this.settings.difficulty);
          const thinking = randomBetween(800, 1500) * this.speed;
          await sleep(Math.max(0, thinking - (Date.now() - started)));
        }
        if (!this.isCurrent(session)) return;
        game.act(player.id, action);
        this.render();
      }
    }

    /** Affiche les boutons d'action et attend le choix du joueur. */
    askHuman() {
      const game = this.game;
      const human = game.humanPlayer;
      this.legal = game.getLegalActions(human.id);
      const promise = new Promise((resolve) => {
        this.pendingAction = resolve;
      });
      this.configureActionPanel(this.legal, human);
      return promise;
    }

    submitAction(action) {
      if (!this.pendingAction) return;
      const resolve = this.pendingAction;
      this.pendingAction = null;
      this.legal = null;
      this.el.actionPanel.hidden = true;
      resolve(action);
    }

    waitForNext(label) {
      this.el.btnNext.textContent = label;
      this.el.nextPanel.hidden = false;
      this.renderStatus();
      return new Promise((resolve) => {
        this.pendingNext = () => {
          this.pendingNext = null;
          this.el.nextPanel.hidden = true;
          resolve();
        };
      });
    }

    /* ------------------------------------------------------------------ */
    /* Panneau d'actions                                                   */
    /* ------------------------------------------------------------------ */

    configureActionPanel(legal, human) {
      const { el } = this;
      el.btnCall.textContent = legal.canCheck
        ? 'Checker'
        : legal.toCall >= human.chips ? `Suivre ${fmt(legal.toCall)} (tapis)` : `Suivre ${fmt(legal.toCall)}`;

      const onlyAllIn = legal.canRaise && legal.minRaiseTo >= legal.maxRaiseTo;
      el.raiseRow.hidden = !legal.canRaise || onlyAllIn;
      el.btnRaise.hidden = !legal.canRaise || onlyAllIn;
      el.btnAllin.hidden = !legal.canRaise;
      el.btnAllin.textContent = `Tapis ${fmt(legal.maxRaiseTo)}`;

      if (legal.canRaise) {
        el.slider.min = legal.minRaiseTo;
        el.slider.max = legal.maxRaiseTo;
        el.slider.step = 1;
        el.slider.value = legal.minRaiseTo;
        this.updateRaiseLabel();
      }
      el.actionPanel.hidden = false;
      this.renderStatus();
    }

    updateRaiseLabel() {
      const { el, legal } = this;
      if (!legal) return;
      const value = Number(el.slider.value);
      el.raiseValue.textContent = fmt(value);
      if (value >= legal.maxRaiseTo) el.btnRaise.textContent = `Tapis ${fmt(value)}`;
      else el.btnRaise.textContent = legal.isBet ? `Miser ${fmt(value)}` : `Relancer à ${fmt(value)}`;
      // Remplissage visuel du curseur
      const span = legal.maxRaiseTo - legal.minRaiseTo || 1;
      el.slider.style.setProperty('--fill', `${((value - legal.minRaiseTo) / span) * 100}%`);
    }

    setRaiseValue(value) {
      const { legal } = this;
      if (!legal) return;
      const clamped = Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, Math.round(value)));
      this.el.slider.value = clamped;
      this.updateRaiseLabel();
    }

    stepRaise(direction) {
      this.setRaiseValue(Number(this.el.slider.value) + direction * this.game.blinds.bb);
    }

    /** ½ pot / pot / tapis : montant « relancer à » correspondant. */
    applyPreset(preset) {
      const { legal } = this;
      if (!legal) return;
      const potAfterCall = legal.potTotal + legal.toCall;
      if (preset === 'half') this.setRaiseValue(legal.currentBet + potAfterCall / 2);
      else if (preset === 'pot') this.setRaiseValue(legal.currentBet + potAfterCall);
      else this.setRaiseValue(legal.maxRaiseTo);
    }

    /* ------------------------------------------------------------------ */
    /* Table                                                               */
    /* ------------------------------------------------------------------ */

    /** Dimensionne l'ovale selon la place disponible (horizontal sur ordinateur, vertical sur téléphone). */
    layoutTable() {
      const { tableWrap, table } = this.el;
      const rect = tableWrap.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const portrait = rect.width / rect.height < 1.05;
      const compact = rect.width < 560 || rect.height < 420;
      const ratio = portrait ? 0.68 : 1.9;                     // largeur / hauteur de l'ovale
      const padX = portrait ? 46 : compact ? 64 : 84;          // marge pour les sièges qui débordent
      const padY = compact ? 50 : 76;
      let width = Math.max(120, rect.width - 2 * padX);
      let height = Math.max(120, rect.height - 2 * padY);
      if (width / height > ratio) width = height * ratio;
      else height = width / ratio;
      table.style.width = `${Math.round(width)}px`;
      table.style.height = `${Math.round(height)}px`;
      table.classList.toggle('portrait', portrait);
      document.body.classList.toggle('compact', compact);
    }

    /** Crée un siège par joueur autour de l'ovale (le joueur humain en bas). */
    buildSeats() {
      const { table } = this.el;
      table.querySelectorAll('.seat, .bet-chip').forEach((node) => node.remove());
      const players = this.game.players;
      const n = players.length;

      this.seats = players.map((player, i) => {
        // Sens des aiguilles d'une montre depuis le bas : bas → gauche → haut → droite
        const angle = ((90 + (i * 360) / n) * Math.PI) / 180;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);

        const seat = document.createElement('div');
        seat.className = 'seat' + (player.isHuman ? ' human' : '') + (sin < -0.3 ? ' top' : '');
        seat.style.left = `${50 + 50 * cos}%`;
        seat.style.top = `${50 + 50 * sin}%`;
        seat.innerHTML = `
          <div class="seat-cards"></div>
          <div class="seat-box">
            <div class="avatar" aria-hidden="true">${escapeHtml(player.name.charAt(0).toUpperCase())}</div>
            <div class="seat-text">
              <div class="seat-name">${escapeHtml(player.name)}</div>
              <div class="seat-chips"></div>
            </div>
            <div class="seat-badges"></div>
          </div>
          <div class="seat-action"></div>
          <div class="seat-hand-name"></div>`;
        table.appendChild(seat);

        const bet = document.createElement('div');
        bet.className = 'bet-chip';
        bet.style.left = `${50 + 50 * 0.6 * cos}%`;
        bet.style.top = `${50 + 50 * 0.56 * sin}%`;
        table.appendChild(bet);

        return {
          root: seat,
          cards: seat.querySelector('.seat-cards'),
          chips: seat.querySelector('.seat-chips'),
          badges: seat.querySelector('.seat-badges'),
          action: seat.querySelector('.seat-action'),
          handName: seat.querySelector('.seat-hand-name'),
          bet,
          signature: '',
          badgeKey: '',
        };
      });
    }

    /* ------------------------------------------------------------------ */
    /* Rendu                                                               */
    /* ------------------------------------------------------------------ */

    render() {
      const game = this.game;
      if (!game) return;
      this.el.infoHand.textContent = `Main n°${game.handNumber}`;
      this.el.infoBlinds.textContent = `Blinds ${fmt(game.blinds.sb)} / ${fmt(game.blinds.bb)}`;
      this.renderPot();
      this.renderBoard();
      game.players.forEach((p) => this.renderSeat(p));
      this.renderHighlights();
      this.renderResult();
      this.renderStatus();
    }

    renderPot() {
      const game = this.game;
      const total = game.getPotTotal();
      // visibility (et non display) : le tableau garde la même position quand le pot disparaît
      this.el.pot.style.visibility = total === 0 ? 'hidden' : 'visible';
      this.el.potAmount.textContent = `Pot : ${fmt(total)}`;

      // Détail des side pots (jetons déjà ramassés) dès qu'il y en a plusieurs
      const pots = game.phase === PHASE.HAND_OVER ? [] : game.computePots(true);
      this.el.sidePots.innerHTML = pots.length > 1
        ? pots.map((pot, i) => `<span>${i === 0 ? 'Principal' : 'Annexe ' + i} : ${fmt(pot.amount)}</span>`).join('')
        : '';
      this.el.streetLabel.textContent = game.phase === PHASE.HAND_OVER ? '' : PHASE_LABELS[game.phase] || '';
    }

    renderBoard() {
      const game = this.game;
      const board = this.el.board;
      if (this.boardHand !== game.handNumber) {
        // Nouvelle main : 5 emplacements vides
        board.innerHTML = '';
        for (let i = 0; i < 5; i++) {
          const slot = document.createElement('div');
          slot.className = 'card-slot';
          board.appendChild(slot);
        }
        this.boardHand = game.handNumber;
      }
      const slots = board.children;
      let newIndex = 0;
      game.community.forEach((card, i) => {
        if (slots[i].firstChild) return;
        const el = createCardElement(card, true);
        el.classList.add('deal');
        el.style.animationDelay = `${newIndex * 140 * Math.max(this.speed, 0.3)}ms`;
        newIndex++;
        slots[i].appendChild(el);
      });
    }

    renderSeat(player) {
      const game = this.game;
      const seat = this.seats[player.id];
      const handOver = game.phase === PHASE.HAND_OVER;

      seat.root.classList.toggle('active', game.toAct === player.id && !handOver);
      seat.root.classList.toggle('folded', player.folded && !player.eliminated);
      // Un joueur éliminé n'est grisé qu'à partir de la main suivante (pour voir son abattage).
      const goneEarlier = player.eliminated && player.eliminatedAt !== game.handNumber;
      seat.root.classList.toggle('eliminated', goneEarlier);
      seat.root.classList.toggle('winner', handOver && player.isWinner);
      seat.root.classList.toggle('all-in', player.allIn && !handOver);

      seat.chips.textContent = goneEarlier ? 'Éliminé' : `${fmt(player.chips)} ${player.chips > 1 ? 'jetons' : 'jeton'}`;

      // Badges Dealer / SB / BB
      const badges = [];
      if (player.id === game.dealerIndex) badges.push('<span class="badge badge-dealer" title="Donneur">D</span>');
      if (player.id === game.sbIndex) badges.push('<span class="badge badge-sb" title="Petite blinde">SB</span>');
      if (player.id === game.bbIndex) badges.push('<span class="badge badge-bb" title="Grosse blinde">BB</span>');
      const badgeKey = badges.join('');
      if (badgeKey !== seat.badgeKey) {
        seat.badges.innerHTML = badgeKey;
        seat.badgeKey = badgeKey;
      }

      // Dernière action (ou gain en fin de main)
      let actionText = player.lastAction;
      if (handOver && player.wonAmount > 0) actionText = `+${fmt(player.wonAmount)}`;
      seat.action.textContent = actionText;
      seat.action.hidden = !actionText;
      seat.action.className = 'seat-action' + (handOver && player.wonAmount > 0 ? ' win' : '') +
        (/Tapis/.test(actionText) ? ' allin' : '') + (actionText === 'Se couche' ? ' fold' : '');

      // Mise devant le joueur
      seat.bet.hidden = player.bet === 0;
      seat.bet.innerHTML = player.bet ? `<span class="chip-icon" aria-hidden="true"></span>${fmt(player.bet)}` : '';

      // Nom de la main à l'abattage
      const showName = handOver && player.showCards && player.bestHand;
      seat.handName.textContent = showName ? player.bestHand.name : '';
      seat.handName.hidden = !showName;

      // Cartes : recréées seulement si elles changent (pour déclencher les animations)
      const faceUp = player.isHuman || player.showCards;
      const visible = player.hand.length > 0 && !(player.folded && !player.isHuman);
      const signature = [game.handNumber, player.hand.map((c) => c.id).join(','), faceUp, visible].join('|');
      if (signature !== seat.signature) {
        const previous = seat.signature.split('|');
        const isFlip = previous[0] === String(game.handNumber) && previous[2] === 'false' && faceUp;
        seat.cards.innerHTML = '';
        if (visible) {
          player.hand.forEach((card, i) => {
            const el = createCardElement(card, faceUp);
            el.classList.add(isFlip ? 'flip' : 'deal');
            el.style.animationDelay = isFlip ? `${i * 90}ms` : `${(player.id * 2 + i) * 60 * Math.max(this.speed, 0.3)}ms`;
            seat.cards.appendChild(el);
          });
        }
        seat.signature = signature;
      }
    }

    /** À l'abattage : surligne les 5 cartes gagnantes, assombrit les autres. */
    renderHighlights() {
      const game = this.game;
      const highlight = game.phase === PHASE.HAND_OVER && game.results && game.results.type === 'showdown'
        ? game.results.highlight
        : null;
      this.el.table.querySelectorAll('.card[data-card-id]').forEach((el) => {
        const isHighlighted = !!highlight && highlight.has(el.dataset.cardId);
        el.classList.toggle('highlight', isHighlighted);
        const inBoard = el.parentElement && el.parentElement.classList.contains('card-slot');
        const winnerCard = el.closest('.seat.winner');
        el.classList.toggle('dim', !!highlight && !isHighlighted && (inBoard || !!winnerCard));
      });
    }

    renderResult() {
      const game = this.game;
      const banner = this.el.resultBanner;
      if (game.phase !== PHASE.HAND_OVER || !game.results) {
        banner.hidden = true;
        return;
      }
      const name = (id) => escapeHtml(game.players[id].name);
      const lines = game.results.pots.map((pot) => {
        const label = game.results.pots.length > 1 ? `<span class="result-pot">${pot.label}</span> ` : '';
        const hand = pot.handName ? ` <span class="result-hand">${escapeHtml(pot.handName)}</span>` : '';
        if (pot.winners.length === 1) {
          const suffix = game.results.type === 'uncontested' ? ' <span class="result-hand">les autres se sont couchés</span>' : '';
          return `<div>${label}<strong>${name(pot.winners[0].id)}</strong> remporte ${fmt(pot.amount)}${hand}${suffix}</div>`;
        }
        const names = pot.winners.map((w) => `<strong>${name(w.id)}</strong>`).join(' et ');
        return `<div>${label}Égalité : ${names} se partagent ${fmt(pot.amount)}${hand}</div>`;
      });
      banner.innerHTML = lines.join('');
      banner.hidden = false;
    }

    renderStatus() {
      const game = this.game;
      const { status } = this.el;
      if (!game) return;
      const human = game.humanPlayer;
      let text = '';
      if (this.pendingAction) {
        const legal = this.legal;
        text = legal && legal.canCall
          ? `À vous : ${fmt(legal.toCall)} à suivre · pot ${fmt(legal.potTotal)}`
          : 'À vous de jouer';
      } else if (game.phase === PHASE.HAND_OVER) {
        if (game.isGameOver()) text = human.eliminated ? 'Vous n’avez plus de jetons…' : 'Vous avez gagné la partie !';
        else text = human.isWinner ? `Bien joué ! Vous remportez ${fmt(human.wonAmount)}.` : 'Main terminée.';
      } else if (game.allInRunout) {
        text = 'Tapis ! Déroulement du tableau…';
      } else {
        const current = game.currentPlayer();
        if (human.folded) text = current ? `Vous êtes hors du coup · ${current.name} réfléchit…` : 'Vous êtes hors du coup';
        else text = current ? `${current.name} réfléchit…` : '';
      }
      status.textContent = text;
      status.classList.toggle('your-turn', !!this.pendingAction);
    }

    appendLog(entry) {
      const li = document.createElement('li');
      li.className = `log-${entry.kind}`;
      li.textContent = entry.text;
      const list = this.el.logList;
      list.appendChild(li);
      while (list.children.length > 500) list.removeChild(list.firstChild);
      list.scrollTop = list.scrollHeight;
    }

    /* ------------------------------------------------------------------ */
    /* Fin de partie                                                       */
    /* ------------------------------------------------------------------ */

    showEndScreen() {
      const game = this.game;
      const human = game.humanPlayer;
      const ranking = game.getRanking();
      const humanPlace = ranking.find((r) => r.player === human).place;
      const total = game.players.length;
      const won = humanPlace === 1;

      this.el.endIcon.textContent = won ? '🏆' : '🃏';
      this.el.endTitle.textContent = won ? 'Victoire !' : 'Partie terminée';
      this.el.endSubtitle.textContent = won
        ? `Vous avez remporté tous les jetons en ${game.handNumber} mains.`
        : `Vous terminez à la ${humanPlace}${humanPlace === 1 ? 're' : 'e'} place sur ${total}, après ${game.handNumber} mains.`;

      this.el.endRanking.innerHTML = ranking.map(({ player, place }) => {
        const detail = player.eliminated
          ? `sorti à la main n°${player.eliminatedAt}`
          : `${fmt(player.chips)} jetons`;
        return `<li class="${player.isHuman ? 'me' : ''}"><span class="rank-place">${place}</span>` +
          `<span class="rank-name">${escapeHtml(player.name)}${player.isHuman ? ' (vous)' : ''}</span>` +
          `<span class="rank-detail">${detail}</span></li>`;
      }).join('');
      this.showScreen('end');
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    Poker.app = new PokerApp();
  });
})(window);
