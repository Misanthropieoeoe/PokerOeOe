/**
 * ui.js — Interface graphique : écrans, table, boutons, salle d'attente.
 *
 * L'interface ne lit jamais directement le moteur : elle dessine une « vue »
 * (voir PokerGame.buildView) qui ne contient que ce que le joueur a le droit de
 * voir. Trois modes :
 *   - solo   : le moteur tourne ici, contre des bots ;
 *   - host   : le moteur tourne ici, et chaque invité reçoit sa vue par le réseau ;
 *   - client : on reçoit les vues de l'hôte et on lui envoie ses actions.
 *
 * Paramètres d'URL pour les tests : ?vitesse=rapide (délais raccourcis),
 * ?tour=10 (secondes par tour en ligne), et ceux de net.js pour le serveur PeerJS.
 */
(function (root) {
  'use strict';

  const Poker = root.Poker;
  const { RANK_LABELS, SUIT_SYMBOLS, isRed, cardName, cardLabel, shuffle } = Poker.Cards;
  const { PokerGame, PHASE, PHASE_LABELS, GameRunner, Net, Looks } = Poker;
  const fmt = Poker.formatChips;

  const MAX_SEATS = 6;
  const STARTING_CHIPS = 1000;
  const HANDS_PER_LEVEL = 10;
  const BOT_NAMES = ['Léa', 'Hugo', 'Chloé', 'Malik', 'Inès', 'Théo', 'Zoé', 'Karim', 'Emma', 'Lucas', 'Nora', 'Yanis'];

  const DIFFICULTY_HINTS = {
    facile: 'Des bots qui suivent beaucoup et ne bluffent jamais.',
    moyen: 'Des bots solides qui calculent leurs chances.',
    difficile: 'Des bots agressifs, attentifs à la position… et qui bluffent.',
  };
  const START_LABELS = { solo: 'Commencer la partie', create: 'Créer la table', join: 'Rejoindre la table', ranked: 'Chercher des adversaires' };
  const RANKED_LOBBY_MS = 40000; // partie classée : démarrage automatique au plus tard après 40 s

  const HEARTBEAT_MS = 2000;      // fréquence des « ping » réseau
  const GUEST_TIMEOUT_MS = 9000;  // invité silencieux → considéré déconnecté
  const HOST_TIMEOUT_MS = 12000;  // hôte silencieux → reconnexion

  const SETTINGS_KEY = 'poker-holdem-reglages';
  const TOKEN_KEY = 'poker-holdem-joueur';

  /* ------------------------------------------------------------------ */
  /* Utilitaires                                                         */
  /* ------------------------------------------------------------------ */

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function chipsLabel(n) {
    return `${fmt(n)} ${n > 1 ? 'jetons' : 'jeton'}`;
  }

  function cleanName(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 14) || 'Joueur';
  }

  function storageGet(key) {
    try { return root.localStorage.getItem(key); } catch (e) { return null; }
  }

  function storageSet(key, value) {
    try { root.localStorage.setItem(key, value); } catch (e) { /* stockage indisponible */ }
  }

  /** Noms de bots qui ne reprennent pas ceux des joueurs humains. */
  function pickBotNames(count, takenNames) {
    const taken = new Set(takenNames.map((n) => n.toLowerCase()));
    return shuffle(BOT_NAMES.filter((n) => !taken.has(n.toLowerCase()))).slice(0, count);
  }

  /** Crée l'élément DOM d'une carte (face visible ou dos). */
  function createCardElement(card) {
    const el = document.createElement('div');
    if (!card) {
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

  /* ------------------------------------------------------------------ */
  /* Application                                                         */
  /* ------------------------------------------------------------------ */

  class PokerApp {
    constructor() {
      const byId = (id) => document.getElementById(id);
      this.el = {
        screens: {
          home: byId('screen-home'),
          auth: byId('screen-auth'),
          profile: byId('screen-profile'),
          lobby: byId('screen-lobby'),
          queue: byId('screen-queue'),
          leaderboard: byId('screen-leaderboard'),
          game: byId('screen-game'),
          end: byId('screen-end'),
        },
        form: byId('home-form'),
        nameInput: byId('input-name'),
        codeInput: byId('input-code'),
        difficultyHint: byId('difficulty-hint'),
        homeError: byId('home-error'),
        btnStart: byId('btn-start'),
        lobbyCode: byId('lobby-code'),
        lobbySubtitle: byId('lobby-subtitle'),
        lobbyEyebrow: byId('lobby-eyebrow'),
        shareRow: byId('share-row'),
        shareLink: byId('share-link'),
        btnCopy: byId('btn-copy'),
        lobbyCount: byId('lobby-count'),
        lobbyPlayers: byId('lobby-players'),
        lobbyHost: byId('lobby-host'),
        lobbyBots: byId('lobby-bots'),
        lobbyWait: byId('lobby-wait'),
        lobbyError: byId('lobby-error'),
        btnLaunch: byId('btn-launch'),
        infoHand: byId('info-hand'),
        infoBlinds: byId('info-blinds'),
        infoTable: byId('info-table'),
        infoRanked: byId('info-ranked'),
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
        btnQuit: byId('btn-quit'),
        logPanel: byId('log-panel'),
        logList: byId('log-list'),
        endIcon: byId('end-icon'),
        endTitle: byId('end-title'),
        endSubtitle: byId('end-subtitle'),
        endRanking: byId('end-ranking'),
        endWait: byId('end-wait'),
        btnReplay: byId('btn-replay'),
        btnSettings: byId('btn-settings'),
      };

      const params = new URLSearchParams(root.location.search);
      const fast = params.get('vitesse') === 'rapide';
      this.speed = fast ? 0.05 : 1;
      this.turnTimeMs = (Number(params.get('tour')) || 40) * 1000;
      this.nextHandDelayMs = fast ? 500 : 8000;

      this.settings = this.loadSettings();
      this.token = storageGet(TOKEN_KEY);
      if (!this.token) {
        this.token = Math.random().toString(36).slice(2) + Date.now().toString(36);
        storageSet(TOKEN_KEY, this.token);
      }

      this.mode = null;          // 'solo' | 'host' | 'client'
      this.runner = null;        // GameRunner (solo / hôte)
      this.net = null;           // HostNetwork ou ClientNetwork
      this.lobby = null;         // état de la salle d'attente (hôte)
      this.view = null;          // dernière vue reçue
      this.localAction = null;   // résolveur de l'action locale (solo / hôte)
      this.nextPrompt = null;    // { label, resolve } bouton « Main suivante »
      this.answeredTurnId = null;
      this.panelTurnId = null;
      this.turnDeadline = null;
      this.nextDeadline = null;
      this.seats = [];
      this.seatKey = '';
      this.boardHand = -1;
      this.cardsLoggedHand = -1;

      this.bindEvents();
      this.accountUi = new Poker.AccountUI(this); // comptes joueurs (accountUi.js)
      this.rankedUi = new Poker.RankedUI(this);   // parties classées et classement (ranked.js)
      this.tablesUi = new Poker.PublicTablesUI(this); // liste des tables publiques (tables.js)
      this.rankedGame = null;                     // { matchId } pendant une partie classée
      this.applySettingsToForm();
      this.prefillFromHash();
      // Rafraîchit les comptes à rebours affichés
      setInterval(() => {
        if (this.view && (this.turnDeadline || this.nextDeadline)) this.renderStatus();
      }, 250);
      // Battement de cœur réseau : détecte les joueurs (ou l'hôte) partis sans prévenir
      this.lastTick = Date.now();
      setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    }

    /* ---------------------------------------------------------------- */
    /* Réglages, accueil                                                 */
    /* ---------------------------------------------------------------- */

    loadSettings() {
      const defaults = { name: 'Joueur', bots: 4, difficulty: 'moyen', mode: 'solo', code: '', visibility: 'private' };
      try {
        return Object.assign(defaults, JSON.parse(storageGet(SETTINGS_KEY) || 'null') || {});
      } catch (e) {
        return defaults;
      }
    }

    saveSettings() {
      storageSet(SETTINGS_KEY, JSON.stringify(this.settings));
    }

    applySettingsToForm() {
      const { form } = this.el;
      this.el.nameInput.value = this.settings.name;
      this.el.codeInput.value = this.settings.code || '';
      const check = (name, value) => {
        const input = form.querySelector(`input[name="${name}"][value="${value}"]`);
        if (input) input.checked = true;
      };
      check('bots', this.settings.bots);
      check('difficulty', this.settings.difficulty);
      check('mode', this.settings.mode);
      check('visibility', this.settings.visibility || 'private');
      this.updateHomeForm();
      if (this.accountUi) this.accountUi.applyToHome(); // connecté : pseudo du compte
    }

    /** Un lien d'invitation (…#CODE) ouvre directement l'onglet « Rejoindre ». */
    prefillFromHash() {
      // Uniquement un code (pas les jetons de connexion ajoutés par les e-mails Supabase)
      if (!/^#[A-Za-z0-9]{4,8}$/.test(root.location.hash)) return;
      const code = Net.normalizeCode(root.location.hash.slice(1));
      if (code.length >= 4) {
        this.el.codeInput.value = code;
        this.el.form.querySelector('input[name="mode"][value="join"]').checked = true;
        this.updateHomeForm();
      }
    }

    get homeMode() {
      const checked = this.el.form.querySelector('input[name="mode"]:checked');
      return checked ? checked.value : 'solo';
    }

    updateHomeForm() {
      const mode = this.homeMode;
      this.el.form.querySelectorAll('[data-modes]').forEach((node) => {
        node.hidden = !node.dataset.modes.split(' ').includes(mode);
      });
      const diff = this.el.form.querySelector('input[name="difficulty"]:checked');
      this.el.difficultyHint.textContent = DIFFICULTY_HINTS[diff ? diff.value : 'moyen'];
      if (!this.homeBusy) this.el.btnStart.textContent = START_LABELS[mode];
    }

    setHomeError(message) {
      this.el.homeError.textContent = message || '';
      this.el.homeError.hidden = !message;
    }

    setHomeBusy(label) {
      this.homeBusy = !!label;
      this.el.btnStart.disabled = !!label;
      this.el.btnStart.textContent = label || START_LABELS[this.homeMode];
    }

    showScreen(name) {
      Object.entries(this.el.screens).forEach(([key, screen]) => screen.classList.toggle('active', key === name));
      if (name === 'game') this.layoutTable();
    }

    get activeScreen() {
      return Object.keys(this.el.screens).find((key) => this.el.screens[key].classList.contains('active'));
    }

    bindEvents() {
      const { el } = this;

      // Le message d'erreur disparaît dès qu'on tape (et non à la sortie du champ :
      // sinon le bouton remonte pendant le clic et le clic tombe à côté).
      el.form.addEventListener('input', () => this.setHomeError(''));
      el.form.addEventListener('change', (event) => {
        if (event.target.type === 'radio') this.setHomeError('');
        this.updateHomeForm();
      });
      el.form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (this.homeBusy) return;
        const data = new FormData(el.form);
        const mode = this.homeMode;
        if (mode === 'ranked') {
          // Partie classée : compte vérifié obligatoire (contrôlé aussi par le serveur)
          // Le pseudo du compte sert à se reconnaître entre joueurs de la table classée
          this.settings = Object.assign({}, this.settings, { mode, name: this.accountUi.effectiveName(this.settings.name) });
          this.saveSettings();
          this.setHomeError('');
          this.rankedUi.start();
          return;
        }
        const name = this.accountUi.effectiveName(cleanName(el.nameInput.value));
        // Compte : solde suffisant ; invité : pseudo non réservé par un compte
        this.setHomeBusy('Vérification…');
        const problem = await this.accountUi.checkBeforePlay(name);
        this.setHomeBusy(null);
        if (problem) {
          this.setHomeError(problem);
          return;
        }
        this.settings = {
          name,
          bots: Number(data.get('bots')) || 4,
          difficulty: data.get('difficulty') || 'moyen',
          mode,
          code: Net.normalizeCode(el.codeInput.value),
          visibility: data.get('visibility') === 'public' ? 'public' : 'private',
        };
        this.saveSettings();
        this.setHomeError('');
        if (mode === 'solo') this.startSolo();
        else if (mode === 'create') this.createTable();
        else if (this.settings.code.length < 4) this.setHomeError('Entrez le code de la table (4 caractères ou plus).');
        else this.joinTable(this.settings.code);
      });

      // Actions de jeu
      el.btnFold.addEventListener('click', () => this.submitAction({ type: 'fold' }));
      el.btnCall.addEventListener('click', () => {
        const legal = this.currentLegal();
        if (legal) this.submitAction({ type: legal.canCheck ? 'check' : 'call' });
      });
      el.btnRaise.addEventListener('click', () => this.submitAction({ type: 'raise', amount: Number(el.slider.value) }));
      el.btnAllin.addEventListener('click', () => this.submitAction({ type: 'allin' }));

      el.slider.addEventListener('input', () => this.updateRaiseLabel());
      document.getElementById('raise-minus').addEventListener('click', () => this.stepRaise(-1));
      document.getElementById('raise-plus').addEventListener('click', () => this.stepRaise(1));
      el.actionPanel.querySelectorAll('[data-preset]').forEach((btn) => {
        btn.addEventListener('click', () => this.applyPreset(btn.dataset.preset));
      });

      el.btnNext.addEventListener('click', () => this.onNextClick());

      // Historique (tiroir sur mobile)
      document.getElementById('btn-log').addEventListener('click', () => el.logPanel.classList.toggle('open'));
      document.getElementById('btn-log-close').addEventListener('click', () => el.logPanel.classList.remove('open'));

      // Quitter : confirmation en deux clics, dans la page (confirm() peut être bloqué)
      let quitTimer = null;
      el.btnQuit.addEventListener('click', () => {
        if (el.btnQuit.classList.contains('confirm')) {
          clearTimeout(quitTimer);
          this.resetQuitButton();
          this.leaveToHome();
          return;
        }
        el.btnQuit.classList.add('confirm');
        el.btnQuit.textContent = 'Confirmer ?';
        quitTimer = setTimeout(() => this.resetQuitButton(), 3000);
      });

      // Salle d'attente
      document.getElementById('bots-minus').addEventListener('click', () => this.changeLobbyBots(-1));
      document.getElementById('bots-plus').addEventListener('click', () => this.changeLobbyBots(1));
      el.screens.lobby.querySelectorAll('input[name="lobby-difficulty"]').forEach((input) => {
        input.addEventListener('change', () => {
          if (this.mode !== 'host' || !this.lobby) return;
          this.lobby.difficulty = input.value;
          this.broadcastLobby();
        });
      });
      el.btnLaunch.addEventListener('click', () => this.startHostedGame());
      document.getElementById('btn-lobby-leave').addEventListener('click', () => this.leaveToHome());
      el.btnCopy.addEventListener('click', () => this.copyShareLink());

      // Fin de partie
      el.btnReplay.addEventListener('click', async () => {
        if (this.rankedGame) {
          this.leaveToHome();
          this.rankedUi.start();
        } else if (this.mode === 'solo') {
          const problem = await this.accountUi.checkBeforePlay(this.settings.name);
          if (problem) this.leaveToHome(problem);
          else this.startSolo();
        } else if (this.mode === 'host') {
          this.backToLobby();
        }
      });
      el.btnSettings.addEventListener('click', () => this.leaveToHome());

      // Raccourcis clavier : F = se coucher, C = checker/suivre, R = relancer, Entrée = main suivante
      document.addEventListener('keydown', (event) => {
        if (!el.screens.game.classList.contains('active')) return;
        if (event.target.tagName === 'INPUT' && event.target.type === 'text') return;
        const key = event.key.toLowerCase();
        if (!el.actionPanel.hidden) {
          if (key === 'f') el.btnFold.click();
          else if (key === 'c') el.btnCall.click();
          else if (key === 'r' && !el.btnRaise.hidden) el.btnRaise.click();
        } else if (!el.nextPanel.hidden && (key === 'enter' || key === ' ')) {
          event.preventDefault();
          el.btnNext.click();
        }
      });

      root.addEventListener('resize', () => this.layoutTable());
      root.addEventListener('hashchange', () => this.prefillFromHash());
    }

    heartbeat() {
      const now = Date.now();
      // Si la page était en arrière-plan (minuteurs suspendus), on ne conclut rien cette fois-ci.
      const suspended = now - this.lastTick > HEARTBEAT_MS * 2.5;
      this.lastTick = now;
      if (this.mode === 'host' && this.lobby) {
        this.lobby.guests.forEach((guest) => {
          if (!guest.connected) return;
          if (suspended) guest.lastSeen = now;
          if (now - guest.lastSeen > GUEST_TIMEOUT_MS) {
            const conn = guest.conn;
            this.onGuestLeft(conn);
            this.net.close(conn);
          } else {
            this.net.send(guest.conn, { t: 'ping' });
          }
        });
      } else if (this.mode === 'client' && this.net) {
        if (suspended) this.hostLastSeen = now;
        if (now - this.hostLastSeen > HOST_TIMEOUT_MS) this.reconnectToHost();
        else this.net.send({ t: 'ping' });
      }
    }

    /** Connexion perdue avec l'hôte : une tentative automatique pour reprendre sa place. */
    reconnectToHost() {
      const code = this.clientCode;
      const ranked = this.pendingRanked;
      // La partie suivie sur le compte continue après la reconnexion
      this.reconnecting = true;
      this.leaveToHome();
      this.setHomeError('');
      this.joinTable(code, true, ranked);
      this.reconnecting = false;
    }

    resetQuitButton() {
      this.el.btnQuit.classList.remove('confirm');
      this.el.btnQuit.textContent = 'Quitter';
    }

    /** Arrête tout (partie, réseau) et revient à l'accueil, avec un message éventuel. */
    leaveToHome(message) {
      this.teardown();
      this.applySettingsToForm();
      this.setHomeBusy(null);
      this.setHomeError(message || '');
      this.showScreen('home');
    }

    teardown() {
      if (this.accountUi && !this.reconnecting) this.accountUi.abandon();
      if (this.lobby && this.lobby.rankedTimer) clearInterval(this.lobby.rankedTimer);
      this.unlistTable();
      if (!this.reconnecting) this.rankedGame = null;
      if (this.runner) this.runner.stop();
      this.runner = null;
      if (this.net) {
        if (this.mode === 'host' && this.lobby) {
          this.lobby.guests.forEach((g) => g.connected && this.net.send(g.conn, { t: 'closed' }));
        } else if (this.mode === 'client') {
          this.net.send({ t: 'leave' });
        }
        const net = this.net;
        setTimeout(() => net.destroy(), 150); // laisse partir le dernier message
      }
      this.net = null;
      this.mode = null;
      this.lobby = null;
      this.resetTableState();
    }

    resetTableState() {
      this.view = null;
      this.localAction = null;
      this.nextPrompt = null;
      this.answeredTurnId = null;
      this.panelTurnId = null;
      this.turnDeadline = null;
      this.nextDeadline = null;
      this.seatKey = '';
      this.boardHand = -1;
      this.cardsLoggedHand = -1;
      this.el.actionPanel.hidden = true;
      this.el.nextPanel.hidden = true;
      this.el.resultBanner.hidden = true;
      this.el.logList.innerHTML = '';
      this.el.logPanel.classList.remove('open');
      this.resetQuitButton();
    }

    /* ---------------------------------------------------------------- */
    /* Solo                                                              */
    /* ---------------------------------------------------------------- */

    startSolo() {
      this.teardown();
      this.mode = 'solo';
      const { name, bots, difficulty } = this.settings;
      const players = [{ name, kind: 'local', look: Poker.Account.look }]
        .concat(pickBotNames(bots, [name]).map((n) => ({ name: n, kind: 'bot' })));
      const game = new PokerGame({ players, startingChips: STARTING_CHIPS, handsPerLevel: HANDS_PER_LEVEL });
      this.accountUi.beginGame(players.length); // mise prélevée si connecté
      this.startRunner(game, { difficulty, multiplayer: false });
    }

    /** Lance la boucle de jeu locale (solo ou hôte). Le joueur local est toujours au siège 0. */
    startRunner(game, { difficulty, multiplayer }) {
      this.resetTableState();
      this.el.infoTable.hidden = !multiplayer;
      if (multiplayer) this.el.infoTable.textContent = `Table ${this.lobby.code}`;
      this.el.infoRanked.hidden = !this.rankedGame;
      this.runner = new GameRunner(game, {
        difficulty,
        speed: this.speed,
        localId: 0,
        multiplayer,
        turnTimeMs: this.turnTimeMs,
        nextHandDelayMs: this.nextHandDelayMs,
        hooks: {
          onLocalView: (view) => this.onView(view),
          askLocalAction: () => new Promise((resolve) => {
            this.localAction = resolve;
            this.renderControls();
          }),
          cancelLocalAction: () => {
            this.localAction = null;
            this.renderControls();
          },
          askLocalNext: (label) => new Promise((resolve) => {
            this.nextPrompt = { label, resolve };
            this.renderControls();
          }),
          cancelLocalNext: () => {
            this.nextPrompt = null;
            this.renderControls();
          },
          sendTo: (seatId, message) => this.sendToSeat(seatId, message),
          onLog: (entry) => {
            this.appendLog(entry);
            if (this.mode === 'host') this.broadcastToSeated({ t: 'log', entry });
          },
        },
      });
      this.showScreen('game');
      this.runner.run();
    }

    /* ---------------------------------------------------------------- */
    /* Hôte d'une table en ligne                                         */
    /* ---------------------------------------------------------------- */

    /**
     * Crée une table en ligne.
     * @param {Object} [options]
     * @param {{matchId:number, players:string[]}} [options.ranked] table formée par le matchmaking
     * @returns {Promise<string|null>} code de la table, ou null en cas d'échec
     */
    async createTable(options = {}) {
      this.teardown();
      this.setHomeBusy('Création de la table…');
      let net;
      try {
        net = await Net.HostNetwork.create();
      } catch (error) {
        this.setHomeBusy(null);
        this.setHomeError(error.message);
        return null;
      }
      this.setHomeBusy(null);
      this.mode = 'host';
      this.net = net;
      this.lobby = {
        code: net.code,
        hostName: this.settings.name,
        bots: 2,
        difficulty: this.settings.difficulty,
        guests: [],      // { token, name, conn, connected, seat }
        started: false,
        ranked: null,
        visibility: options.ranked ? 'private' : (this.settings.visibility || 'private'),
        listing: null,   // { token } quand la table est inscrite dans la liste publique
      };
      if (options.ranked) {
        // Partie classée : seuls les joueurs choisis par le matchmaking, sans bots ; démarrage automatique
        const me = this.lobby.hostName.toLowerCase();
        this.lobby.bots = 0;
        this.lobby.ranked = {
          matchId: options.ranked.matchId,
          expected: new Set(options.ranked.players.map((n) => n.toLowerCase()).filter((n) => n !== me)),
          deadline: Date.now() + RANKED_LOBBY_MS,
        };
        this.lobby.rankedTimer = setInterval(() => this.checkRankedLobby(), 1000);
      }
      net.on('message', (conn, message) => this.onHostMessage(conn, message));
      net.on('disconnect', (conn) => this.onGuestLeft(conn));
      net.on('error', (message) => this.showNetworkWarning(message));
      this.broadcastLobby();
      this.showScreen('lobby');
      if (this.lobby.visibility === 'public') this.publishTable();
      return net.code;
    }

    /* ---------------------------------------------------------------- */
    /* Table publique : inscription dans la liste « Rejoindre »          */
    /* ---------------------------------------------------------------- */

    listingInfo() {
      const { lobby } = this;
      return {
        code: lobby.code,
        pseudo: lobby.hostName,
        players: 1 + lobby.guests.filter((g) => g.connected).length,
        bots: lobby.bots,
        difficulty: lobby.difficulty,
      };
    }

    async publishTable() {
      const lobby = this.lobby;
      if (!lobby || lobby.listing || lobby.started) return;
      lobby.listingError = '';
      try {
        const token = await Poker.Account.openTable(this.listingInfo());
        if (this.lobby !== lobby || lobby.started) {
          Poker.Account.closeTable(lobby.code, token).catch(() => {}); // table fermée entre-temps
          return;
        }
        lobby.listing = { token };
        // Signe de vie toutes les 10 s : sans nouvelles depuis 30 s, la table disparaît de la liste
        lobby.listingTimer = setInterval(() => this.refreshListing(), 10000);
      } catch (error) {
        lobby.listingError = `Table non publiée : ${error.message} Partagez plutôt le code.`;
      }
      if (this.lobby === lobby && !lobby.started) this.renderLobby(this.lobbyPayload());
    }

    /** Met à jour la liste (joueurs, bots, difficulté) ; republie si l'inscription a expiré. */
    refreshListing() {
      const lobby = this.lobby;
      if (!lobby || !lobby.listing || lobby.started) return;
      Poker.Account.updateTable(Object.assign({ token: lobby.listing.token }, this.listingInfo())).catch(() => {
        // Expirée (onglet en veille par exemple) : nouvelle inscription
        if (this.lobby !== lobby) return;
        clearInterval(lobby.listingTimer);
        lobby.listing = null;
        this.publishTable();
      });
    }

    /** Retire la table de la liste (partie lancée, table fermée). */
    unlistTable() {
      const lobby = this.lobby;
      if (!lobby) return;
      if (lobby.listingTimer) clearInterval(lobby.listingTimer);
      lobby.listingTimer = null;
      if (lobby.listing) Poker.Account.closeTable(lobby.code, lobby.listing.token).catch(() => {});
      lobby.listing = null;
    }

    /** Clic sur « Rejoindre » dans la liste des tables publiques. */
    joinFromList(code) {
      const { form, codeInput } = this.el;
      codeInput.value = code;
      form.querySelector('input[name="mode"][value="join"]').checked = true;
      this.updateHomeForm();
      form.requestSubmit(); // mêmes vérifications qu'un code saisi (pseudo, etc.)
    }

    /** Partie classée : démarre dès que tout le monde est là, ou à la fin du délai. */
    checkRankedLobby() {
      const { lobby } = this;
      if (this.mode !== 'host' || !lobby || !lobby.ranked || lobby.started) return;
      const present = lobby.guests.filter((g) => g.connected).length;
      if (present >= lobby.ranked.expected.size) {
        this.startHostedGame();
      } else if (Date.now() >= lobby.ranked.deadline) {
        if (present >= 1) {
          this.startHostedGame();
        } else {
          Poker.Account.cancelMatch(lobby.ranked.matchId).catch(() => {});
          this.leaveToHome();
          this.rankedUi.restart('Aucun adversaire n’a rejoint la table. Nouvelle recherche…');
        }
      } else {
        this.broadcastLobby(); // compte à rebours
      }
    }

    onHostMessage(conn, message) {
      if (!message || typeof message !== 'object' || this.mode !== 'host') return;
      if (message.t === 'join') {
        this.onGuestJoin(conn, message);
        return;
      }
      const guest = this.lobby.guests.find((g) => g.conn === conn);
      if (!guest) return;
      guest.lastSeen = Date.now();
      if (message.t === 'action' && this.runner && guest.seat != null) this.runner.receiveRemoteAction(guest.seat, message);
      else if (message.t === 'leave') this.onGuestLeft(conn);
    }

    onGuestJoin(conn, message) {
      const { lobby, net } = this;
      const token = String(message.token || '').slice(0, 64);
      const existing = token ? lobby.guests.find((g) => g.token === token) : null;

      // Retour d'un joueur déjà inscrit (rechargement de page, coupure réseau...)
      if (existing) {
        if (existing.conn && existing.conn !== conn) net.close(existing.conn);
        existing.conn = conn;
        existing.connected = true;
        existing.lastSeen = Date.now();
        if (!lobby.started) existing.look = Looks.sanitize(message.look);
        net.send(conn, { t: 'welcome', code: lobby.code, name: existing.name });
        if (lobby.started && existing.seat != null && this.runner) {
          net.send(conn, { t: 'logs', entries: this.runner.game.history.slice(-150) });
          this.runner.setConnected(existing.seat, true);
          this.runner.publish();
        } else {
          this.broadcastLobby();
        }
        return;
      }

      const refuse = (reason) => {
        net.send(conn, { t: 'refused', reason });
        setTimeout(() => net.close(conn), 400);
      };
      if (lobby.started) return refuse('La partie a déjà commencé. Réessayez quand l’hôte aura relancé une partie.');
      if (lobby.ranked && !lobby.ranked.expected.has(cleanName(message.name).toLowerCase())) {
        return refuse('Cette table est réservée à une partie classée.');
      }
      if (1 + lobby.guests.length >= MAX_SEATS) return refuse(`La table est complète (${MAX_SEATS} joueurs maximum).`);

      // Pseudo unique à la table
      const base = cleanName(message.name);
      const taken = new Set([lobby.hostName].concat(lobby.guests.map((g) => g.name)).map((n) => n.toLowerCase()));
      let name = base;
      for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base.slice(0, 12)} ${i}`;

      lobby.guests.push({
        token, name, conn, connected: true, seat: null, lastSeen: Date.now(),
        account: !!message.account,
        look: Looks.sanitize(message.look), // apparence vérifiée (cadre connu, photo du stockage du projet)
      });
      lobby.bots = Math.min(lobby.bots, MAX_SEATS - 1 - lobby.guests.length);
      net.send(conn, { t: 'welcome', code: lobby.code, name });
      this.broadcastLobby();
      if (lobby.ranked) this.checkRankedLobby();
    }

    onGuestLeft(conn) {
      if (this.mode !== 'host' || !this.lobby) return;
      const guest = this.lobby.guests.find((g) => g.conn === conn);
      if (!guest) return;
      guest.conn = null;
      guest.connected = false;
      if (!this.lobby.started) {
        this.lobby.guests = this.lobby.guests.filter((g) => g !== guest);
        this.broadcastLobby();
      } else if (guest.seat != null && this.runner) {
        this.runner.setConnected(guest.seat, false);
      }
    }

    changeLobbyBots(delta) {
      if (this.mode !== 'host' || !this.lobby) return;
      const max = MAX_SEATS - 1 - this.lobby.guests.length;
      this.lobby.bots = Math.max(0, Math.min(max, this.lobby.bots + delta));
      this.broadcastLobby();
    }

    lobbyPayload() {
      const { lobby } = this;
      return {
        t: 'lobby',
        code: lobby.code,
        players: [{ name: lobby.hostName, host: true, account: Poker.Account.signedIn, look: Poker.Account.look }]
          .concat(lobby.guests.map((g) => ({ name: g.name, account: g.account, look: g.look }))),
        bots: lobby.bots,
        difficulty: lobby.difficulty,
        visibility: lobby.visibility,
        listed: !!lobby.listing,
        ranked: lobby.ranked
          ? { players: lobby.ranked.expected.size + 1, secondsLeft: Math.max(0, Math.ceil((lobby.ranked.deadline - Date.now()) / 1000)) }
          : null,
      };
    }

    broadcastLobby() {
      const payload = this.lobbyPayload();
      this.lobby.guests.forEach((g) => g.connected && this.net.send(g.conn, payload));
      this.renderLobby(payload);
      if (!this.lobby.ranked) this.refreshListing(); // joueurs, bots ou difficulté changés
    }

    sendToSeat(seatId, message) {
      if (this.mode !== 'host') return;
      const guest = this.lobby.guests.find((g) => g.seat === seatId && g.connected);
      if (guest) this.net.send(guest.conn, message);
    }

    broadcastToSeated(message) {
      this.lobby.guests.forEach((g) => g.connected && g.seat != null && this.net.send(g.conn, message));
    }

    startHostedGame() {
      const { lobby } = this;
      if (this.mode !== 'host' || lobby.started) return;
      const guests = lobby.guests.filter((g) => g.connected);
      if (1 + guests.length + lobby.bots < 2) return;

      const humans = [lobby.hostName].concat(guests.map((g) => g.name));
      const players = [{ name: lobby.hostName, kind: 'local', look: Poker.Account.look }]
        .concat(guests.map((g) => ({ name: g.name, kind: 'remote', look: g.look })))
        .concat(pickBotNames(lobby.bots, humans).map((n) => ({ name: n, kind: 'bot' })));
      guests.forEach((g, i) => { g.seat = i + 1; });
      lobby.guests = guests;
      lobby.started = true;
      if (lobby.rankedTimer) clearInterval(lobby.rankedTimer);
      this.unlistTable(); // la partie commence : la table quitte la liste publique
      const matchId = lobby.ranked ? lobby.ranked.matchId : null;
      this.rankedGame = matchId ? { matchId } : null;

      const game = new PokerGame({ players, startingChips: STARTING_CHIPS, handsPerLevel: HANDS_PER_LEVEL });
      guests.forEach((g) => this.net.send(g.conn, { t: 'start', code: lobby.code, players: players.length, matchId }));
      this.accountUi.beginGame(players.length, matchId);
      this.startRunner(game, { difficulty: lobby.difficulty, multiplayer: true });
    }

    /** Après une partie : retour à la salle d'attente avec les joueurs toujours connectés. */
    backToLobby() {
      if (this.runner) this.runner.stop();
      this.runner = null;
      const { lobby } = this;
      lobby.started = false;
      lobby.guests = lobby.guests.filter((g) => g.connected);
      lobby.guests.forEach((g) => { g.seat = null; });
      lobby.bots = Math.min(lobby.bots, MAX_SEATS - 1 - lobby.guests.length);
      this.resetTableState();
      this.broadcastLobby();
      this.showScreen('lobby');
      if (lobby.visibility === 'public') this.publishTable();
    }

    showNetworkWarning(message) {
      if (this.activeScreen === 'lobby') {
        this.el.lobbyError.textContent = message;
        this.el.lobbyError.hidden = false;
      } else {
        this.appendLog({ text: message, kind: 'elim' });
      }
    }

    /* ---------------------------------------------------------------- */
    /* Invité                                                            */
    /* ---------------------------------------------------------------- */

    /**
     * @param {string} code code de la table
     * @param {boolean} [retry=false] reconnexion automatique après une coupure
     */
    async joinTable(code, retry = false, ranked = null) {
      this.teardown();
      this.pendingRanked = ranked; // partie classée : en cas d'échec, retour à la recherche
      this.setHomeBusy(retry ? 'Reconnexion à la table…' : 'Connexion à la table…');
      let net;
      try {
        net = await Net.ClientNetwork.connect(code);
      } catch (error) {
        this.setHomeBusy(null);
        if (ranked && !retry) {
          this.rankedUi.joinFailed(error.message);
          return;
        }
        this.setHomeError(retry
          ? 'La connexion avec la table a été perdue. Rejoignez-la avec le même code pour reprendre votre place.'
          : error.message);
        return;
      }
      this.mode = 'client';
      this.net = net;
      this.clientCode = code;
      this.hostLastSeen = Date.now();
      net.on('message', (message) => {
        this.hostLastSeen = Date.now();
        this.onClientMessage(message);
      });
      net.on('close', () => {
        if (this.mode === 'client' && this.net === net) {
          if (this.view && !this.view.gameOver) this.reconnectToHost();
          else this.leaveToHome('La connexion avec la table a été perdue.');
        }
      });
      net.send({ t: 'join', name: this.settings.name, token: this.token, account: Poker.Account.signedIn, look: Poker.Account.look });
      // Sans réponse de l'hôte, on abandonne.
      setTimeout(() => {
        if (this.mode !== 'client' || this.net !== net || !this.homeBusy) return;
        this.leaveToHome('La table ne répond pas.');
        if (ranked && !retry) this.rankedUi.joinFailed('La table ne répond pas.');
      }, 10000);
    }

    onClientMessage(message) {
      if (!message || typeof message !== 'object' || this.mode !== 'client') return;
      switch (message.t) {
        case 'welcome':
          this.setHomeBusy(null);
          this.myName = message.name; // pseudo attribué par l'hôte (un numéro est ajouté en cas de doublon)
          break;
        case 'refused': {
          const ranked = this.pendingRanked;
          this.leaveToHome(message.reason);
          if (ranked) this.rankedUi.joinFailed(message.reason);
          break;
        }
        case 'closed':
          this.leaveToHome('L’hôte a fermé la table.');
          break;
        case 'lobby':
          this.setHomeBusy(null);
          this.resetTableState();
          this.renderLobby(message);
          this.showScreen('lobby');
          break;
        case 'start':
          this.resetTableState();
          this.rankedGame = message.matchId ? { matchId: Number(message.matchId) } : null;
          this.el.infoRanked.hidden = !this.rankedGame;
          this.accountUi.beginGame(Number(message.players) || 2, this.rankedGame ? this.rankedGame.matchId : null);
          break;
        case 'logs':
          this.el.logList.innerHTML = '';
          (message.entries || []).forEach((entry) => this.appendLog(entry));
          break;
        case 'log':
          this.appendLog(message.entry);
          break;
        case 'state':
          this.setHomeBusy(null);
          this.el.infoTable.hidden = false;
          this.el.infoTable.textContent = `Table ${this.clientCode}`;
          if (this.activeScreen !== 'game' && this.activeScreen !== 'end') this.showScreen('game');
          this.onView(message.view);
          break;
        default:
          break;
      }
    }

    /* ---------------------------------------------------------------- */
    /* Salle d'attente                                                   */
    /* ---------------------------------------------------------------- */

    renderLobby(payload) {
      const { el } = this;
      const isHost = this.mode === 'host';
      el.lobbyCode.textContent = payload.code;
      el.lobbyError.hidden = true;

      const online = /^https?:$/.test(root.location.protocol);
      const link = root.location.href.split('#')[0] + '#' + payload.code;
      el.shareRow.hidden = !online;
      el.shareLink.value = link;
      const isPublic = payload.visibility === 'public';
      el.lobbyEyebrow.textContent = isPublic ? '🌍 Table publique · code' : '🔒 Table privée · code';
      if (!isHost) {
        el.lobbySubtitle.textContent = 'Vous êtes à la table. La partie démarre quand l’hôte la lance.';
      } else if (isPublic) {
        el.lobbySubtitle.textContent = payload.listed
          ? 'Table publique : elle apparaît dans la liste « Rejoindre » de tous les joueurs. Vous pouvez aussi partager le code.'
          : 'Table publique : publication dans la liste « Rejoindre »…';
      } else {
        el.lobbySubtitle.textContent = online
          ? 'Table privée : envoyez ce lien (ou le code) à vos amis ; ils choisissent « Rejoindre » et entrent le code.'
          : 'Table privée : donnez ce code à vos amis ; ils ouvrent le jeu, choisissent « Rejoindre » et entrent le code.';
      }
      if (isHost && this.lobby && this.lobby.listingError) {
        el.lobbySubtitle.textContent = this.lobby.listingError;
      }

      const humans = payload.players.length;
      const total = humans + payload.bots;
      el.lobbyCount.textContent = `${total} / ${MAX_SEATS}`;
      const items = payload.players.map((p) => {
        const me = isHost ? p.host : p.name === this.myName;
        const title = Looks.titleName(Looks.sanitize(p.look).title);
        return `<li>${Looks.avatarHtml({ name: p.name, look: p.look, variant: p.host ? 'host' : 'person' })}` +
          `<span class="lobby-name">${escapeHtml(p.name)}${me ? ' (vous)' : ''}` +
          `${title ? `<em class="player-title">${escapeHtml(title)}</em>` : ''}</span>` +
          `<span class="tag">${p.host ? 'Hôte' : p.account ? 'Compte' : 'Invité'}</span></li>`;
      });
      for (let i = 0; i < payload.bots; i++) {
        items.push(`<li class="bot">${Looks.avatarHtml({ name: 'Bot', variant: 'bot', content: '🤖' })}<span class="lobby-name">Bot</span>` +
          `<span class="tag">${escapeHtml(payload.difficulty)}</span></li>`);
      }
      el.lobbyPlayers.innerHTML = items.join('');

      if (payload.ranked) {
        // Partie classée : pas de réglages, démarrage automatique
        el.shareRow.hidden = true;
        el.lobbyEyebrow.textContent = '🏆 Partie classée · code';
        el.lobbySubtitle.textContent = 'Partie classée : la partie démarre dès que tous les joueurs sont là.';
        el.lobbyHost.hidden = true;
        el.lobbyWait.hidden = false;
        el.lobbyWait.textContent = `${humans} / ${payload.ranked.players} joueurs à la table · ` +
          `démarrage au plus tard dans ${payload.ranked.secondsLeft} s`;
        el.lobbyCount.textContent = `${humans} / ${payload.ranked.players}`;
        return;
      }
      el.lobbyHost.hidden = !isHost;
      el.lobbyWait.hidden = isHost;
      if (isHost) {
        el.lobbyBots.textContent = payload.bots;
        const radio = el.screens.lobby.querySelector(`input[name="lobby-difficulty"][value="${payload.difficulty}"]`);
        if (radio) radio.checked = true;
        el.btnLaunch.disabled = total < 2;
        el.btnLaunch.textContent = total < 2 ? 'Ajoutez un bot ou attendez un joueur' : `Lancer la partie (${total} joueurs)`;
      } else {
        el.lobbyWait.textContent = `En attente du lancement par l’hôte · bots : ${payload.bots} (${payload.difficulty})`;
      }
    }

    copyShareLink() {
      const { shareLink, btnCopy } = this.el;
      const done = () => {
        btnCopy.textContent = 'Copié !';
        setTimeout(() => { btnCopy.textContent = 'Copier le lien'; }, 1600);
      };
      const fallback = () => {
        shareLink.focus();
        shareLink.select();
        try { if (document.execCommand('copy')) done(); } catch (e) { /* le texte reste sélectionné */ }
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(shareLink.value).then(done, fallback);
      } else {
        fallback();
      }
    }

    /* ---------------------------------------------------------------- */
    /* Réception d'une vue                                               */
    /* ---------------------------------------------------------------- */

    onView(view) {
      this.view = view;
      const now = Date.now();
      this.turnDeadline = view.turn && view.turn.remainingMs != null ? now + view.turn.remainingMs : null;
      this.nextDeadline = view.nextInMs != null ? now + view.nextInMs : null;

      // Sièges reconstruits si la table change (nouvelle partie, autre point de vue)
      const seatKey = view.viewerId + '|' + view.players.map((p) => p.name).join(',');
      if (seatKey !== this.seatKey) {
        this.buildSeats(view);
        this.seatKey = seatKey;
      }

      // Ses propres cartes : ajoutées à l'historique local uniquement (jamais envoyées aux autres)
      const me = view.players[view.viewerId];
      if (me && me.hand && me.hand.length === 2 && !me.eliminated && this.cardsLoggedHand !== view.handNumber) {
        this.cardsLoggedHand = view.handNumber;
        this.appendLog({ text: `Vos cartes : ${me.hand.map(cardLabel).join(' ')}`, kind: 'private' });
      }
      this.accountUi.trackView(view); // statistiques et fin de partie du compte
      this.render();
    }

    currentLegal() {
      const v = this.view;
      return v && v.legal && v.turn && v.turn.seat === v.viewerId ? v.legal : null;
    }

    /** Le joueur de cet appareil doit-il choisir une action maintenant ? */
    isMyTurn() {
      const v = this.view;
      if (!this.currentLegal() || v.turn.id === this.answeredTurnId) return false;
      return this.mode === 'client' || !!this.localAction;
    }

    submitAction(action) {
      if (!this.isMyTurn()) return;
      const turnId = this.view.turn.id;
      this.answeredTurnId = turnId;
      this.el.actionPanel.hidden = true;
      this.panelTurnId = null;
      if (this.mode === 'client') {
        this.net.send({ t: 'action', turnId, action });
      } else {
        const resolve = this.localAction;
        this.localAction = null;
        resolve(action);
      }
      this.renderStatus();
    }

    onNextClick() {
      const v = this.view;
      if (v && v.gameOver && v.phase === PHASE.HAND_OVER) {
        this.showEndScreen();
      } else if (this.nextPrompt) {
        const { resolve } = this.nextPrompt;
        this.nextPrompt = null;
        this.el.nextPanel.hidden = true;
        resolve();
      }
    }

    /* ---------------------------------------------------------------- */
    /* Panneau d'actions                                                 */
    /* ---------------------------------------------------------------- */

    configureActionPanel(legal, me) {
      const { el } = this;
      el.btnCall.textContent = legal.canCheck
        ? 'Checker'
        : legal.toCall >= me.chips ? `Suivre ${fmt(legal.toCall)} (tapis)` : `Suivre ${fmt(legal.toCall)}`;

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
    }

    updateRaiseLabel() {
      const { el } = this;
      const legal = this.currentLegal();
      if (!legal) return;
      const value = Number(el.slider.value);
      el.raiseValue.textContent = fmt(value);
      if (value >= legal.maxRaiseTo) el.btnRaise.textContent = `Tapis ${fmt(value)}`;
      else el.btnRaise.textContent = legal.isBet ? `Miser ${fmt(value)}` : `Relancer à ${fmt(value)}`;
      const span = legal.maxRaiseTo - legal.minRaiseTo || 1;
      el.slider.style.setProperty('--fill', `${((value - legal.minRaiseTo) / span) * 100}%`);
    }

    setRaiseValue(value) {
      const legal = this.currentLegal();
      if (!legal) return;
      this.el.slider.value = Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, Math.round(value)));
      this.updateRaiseLabel();
    }

    stepRaise(direction) {
      if (!this.view) return;
      this.setRaiseValue(Number(this.el.slider.value) + direction * this.view.blinds.bb);
    }

    /** ½ pot / pot / tapis : montant « relancer à » correspondant. */
    applyPreset(preset) {
      const legal = this.currentLegal();
      if (!legal) return;
      const potAfterCall = legal.potTotal + legal.toCall;
      if (preset === 'half') this.setRaiseValue(legal.currentBet + potAfterCall / 2);
      else if (preset === 'pot') this.setRaiseValue(legal.currentBet + potAfterCall);
      else this.setRaiseValue(legal.maxRaiseTo);
    }

    /* ---------------------------------------------------------------- */
    /* Table                                                             */
    /* ---------------------------------------------------------------- */

    /** Dimensionne l'ovale selon la place disponible (horizontal sur ordinateur, vertical sur téléphone). */
    layoutTable() {
      const { tableWrap, table } = this.el;
      const rect = tableWrap.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const portrait = rect.width / rect.height < 1.05;
      const compact = rect.width < 560 || rect.height < 420;
      const ratio = portrait ? 0.68 : 1.9;
      const padX = portrait ? 46 : compact ? 64 : 84;
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

    /** Un siège par joueur autour de l'ovale ; celui qui regarde est toujours en bas. */
    buildSeats(view) {
      const { table } = this.el;
      table.querySelectorAll('.seat, .bet-chip').forEach((node) => node.remove());
      const n = view.players.length;
      const viewer = Math.max(0, view.viewerId);

      this.seats = view.players.map((player) => {
        const position = (player.id - viewer + n) % n;
        // Sens des aiguilles d'une montre depuis le bas : bas → gauche → haut → droite
        const angle = ((90 + (position * 360) / n) * Math.PI) / 180;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const isMe = player.id === view.viewerId;

        const seat = document.createElement('div');
        seat.className = 'seat' + (isMe ? ' human' : '') + (sin < -0.3 ? ' top' : '');
        seat.style.left = `${50 + 50 * cos}%`;
        seat.style.top = `${50 + 50 * sin}%`;
        const avatarClass = isMe ? 'me' : player.isHuman ? 'person' : 'bot';
        const seatTitle = Looks.titleName(Looks.sanitize(player.look).title);
        seat.innerHTML = `
          <div class="seat-cards"></div>
          <div class="seat-box">
            ${Looks.avatarHtml({ name: player.name, look: player.look, variant: avatarClass })}
            <div class="seat-text">
              <div class="seat-name">${escapeHtml(player.name)}</div>
              ${seatTitle ? `<div class="seat-title">${escapeHtml(seatTitle)}</div>` : ''}
              <div class="seat-chips"></div>
            </div>
            <div class="seat-badges"></div>
          </div>
          <div class="seat-action"></div>
          <div class="seat-hand-name"></div>`;
        if (!player.isHuman) seat.title = 'Bot';
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

    /* ---------------------------------------------------------------- */
    /* Rendu                                                             */
    /* ---------------------------------------------------------------- */

    render() {
      const v = this.view;
      if (!v) return;
      this.el.infoHand.textContent = `Main n°${v.handNumber}`;
      this.el.infoBlinds.textContent = `Blinds ${fmt(v.blinds.sb)} / ${fmt(v.blinds.bb)}`;
      this.renderPot();
      this.renderBoard();
      v.players.forEach((p) => this.renderSeat(p));
      this.renderHighlights();
      this.renderResult();
      this.renderControls();
    }

    renderPot() {
      const v = this.view;
      // visibility (et non display) : le tableau garde la même position quand le pot disparaît
      this.el.pot.style.visibility = v.potTotal === 0 ? 'hidden' : 'visible';
      this.el.potAmount.textContent = `Pot : ${fmt(v.potTotal)}`;
      this.el.sidePots.innerHTML = v.pots.length > 1
        ? v.pots.map((amount, i) => `<span>${i === 0 ? 'Principal' : 'Annexe ' + i} : ${fmt(amount)}</span>`).join('')
        : '';
      this.el.streetLabel.textContent = v.phase === PHASE.HAND_OVER ? '' : PHASE_LABELS[v.phase] || '';
    }

    renderBoard() {
      const v = this.view;
      const board = this.el.board;
      if (this.boardHand !== v.handNumber) {
        board.innerHTML = '';
        for (let i = 0; i < 5; i++) {
          const slot = document.createElement('div');
          slot.className = 'card-slot';
          board.appendChild(slot);
        }
        this.boardHand = v.handNumber;
      }
      const slots = board.children;
      let newIndex = 0;
      v.community.forEach((card, i) => {
        if (slots[i].firstChild) return;
        const el = createCardElement(card);
        el.classList.add('deal');
        el.style.animationDelay = `${newIndex * 140 * Math.max(this.speed, 0.3)}ms`;
        newIndex++;
        slots[i].appendChild(el);
      });
    }

    renderSeat(player) {
      const v = this.view;
      const seat = this.seats[player.id];
      const handOver = v.phase === PHASE.HAND_OVER;
      const offline = player.kind === 'remote' && !player.connected;

      seat.root.classList.toggle('active', v.toAct === player.id && !handOver);
      seat.root.classList.toggle('folded', player.folded && !player.eliminated);
      // Un joueur éliminé n'est grisé qu'à partir de la main suivante (pour voir son abattage).
      const goneEarlier = player.eliminated && player.eliminatedAt !== v.handNumber;
      seat.root.classList.toggle('eliminated', goneEarlier);
      seat.root.classList.toggle('winner', handOver && player.isWinner);
      seat.root.classList.toggle('all-in', player.allIn && !handOver);
      seat.root.classList.toggle('offline', offline && !player.eliminated);

      seat.chips.textContent = goneEarlier ? 'Éliminé' : chipsLabel(player.chips);

      const badges = [];
      if (player.id === v.dealerIndex) badges.push('<span class="badge badge-dealer" title="Donneur">D</span>');
      if (player.id === v.sbIndex) badges.push('<span class="badge badge-sb" title="Petite blinde">SB</span>');
      if (player.id === v.bbIndex) badges.push('<span class="badge badge-bb" title="Grosse blinde">BB</span>');
      const badgeKey = badges.join('');
      if (badgeKey !== seat.badgeKey) {
        seat.badges.innerHTML = badgeKey;
        seat.badgeKey = badgeKey;
      }

      let actionText = player.lastAction;
      if (handOver && player.wonAmount > 0) actionText = `+${fmt(player.wonAmount)}`;
      else if (offline && !player.eliminated) actionText = 'Déconnecté';
      seat.action.textContent = actionText;
      seat.action.hidden = !actionText;
      seat.action.className = 'seat-action' + (handOver && player.wonAmount > 0 ? ' win' : '') +
        (/Tapis/.test(actionText) ? ' allin' : '') + (actionText === 'Se couche' ? ' fold' : '') +
        (actionText === 'Déconnecté' ? ' offline' : '');

      seat.bet.hidden = player.bet === 0;
      seat.bet.innerHTML = player.bet ? `<span class="chip-icon" aria-hidden="true"></span>${fmt(player.bet)}` : '';

      const showName = handOver && player.bestHandName;
      seat.handName.textContent = showName ? player.bestHandName : '';
      seat.handName.hidden = !showName;

      // Cartes : recréées seulement si elles changent (pour déclencher les animations)
      const faceUp = !!player.hand;
      const isMe = player.id === v.viewerId;
      const visible = player.cardCount > 0 && !(player.folded && !isMe);
      const content = faceUp ? player.hand.map((c) => c.id).join(',') : 'dos' + player.cardCount;
      const signature = [v.handNumber, content, faceUp, visible].join('|');
      if (signature !== seat.signature) {
        const previous = seat.signature.split('|');
        const isFlip = previous[0] === String(v.handNumber) && previous[2] === 'false' && faceUp;
        seat.cards.innerHTML = '';
        if (visible) {
          const cards = faceUp ? player.hand : new Array(player.cardCount).fill(null);
          const order = (player.id - Math.max(0, v.viewerId) + v.players.length) % v.players.length;
          cards.forEach((card, i) => {
            const el = createCardElement(card);
            el.classList.add(isFlip ? 'flip' : 'deal');
            el.style.animationDelay = isFlip ? `${i * 90}ms` : `${(order * 2 + i) * 60 * Math.max(this.speed, 0.3)}ms`;
            seat.cards.appendChild(el);
          });
        }
        seat.signature = signature;
      }
    }

    /** À l'abattage : surligne les 5 cartes gagnantes, assombrit les autres. */
    renderHighlights() {
      const v = this.view;
      const highlight = v.phase === PHASE.HAND_OVER && v.results && v.results.type === 'showdown'
        ? new Set(v.results.highlight)
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
      const v = this.view;
      const banner = this.el.resultBanner;
      if (v.phase !== PHASE.HAND_OVER || !v.results) {
        banner.hidden = true;
        return;
      }
      const name = (id) => escapeHtml(v.players[id].name);
      const lines = v.results.pots.map((pot) => {
        const label = v.results.pots.length > 1 ? `<span class="result-pot">${pot.label}</span> ` : '';
        const hand = pot.handName ? ` <span class="result-hand">${escapeHtml(pot.handName)}</span>` : '';
        if (pot.winners.length === 1) {
          const suffix = v.results.type === 'uncontested' ? ' <span class="result-hand">les autres se sont couchés</span>' : '';
          return `<div>${label}<strong>${name(pot.winners[0].id)}</strong> remporte ${fmt(pot.amount)}${hand}${suffix}</div>`;
        }
        const names = pot.winners.map((w) => `<strong>${name(w.id)}</strong>`).join(' et ');
        return `<div>${label}Égalité : ${names} se partagent ${fmt(pot.amount)}${hand}</div>`;
      });
      banner.innerHTML = lines.join('');
      banner.hidden = false;
    }

    /** Boutons d'action, bouton « Main suivante » et message d'état. */
    renderControls() {
      const v = this.view;
      if (!v) return;
      const { el } = this;

      if (this.isMyTurn()) {
        if (this.panelTurnId !== v.turn.id) {
          this.configureActionPanel(v.legal, v.players[v.viewerId]);
          this.panelTurnId = v.turn.id;
        }
        el.actionPanel.hidden = false;
      } else {
        el.actionPanel.hidden = true;
        this.panelTurnId = null;
      }

      if (v.gameOver && v.phase === PHASE.HAND_OVER) {
        el.btnNext.textContent = 'Voir le classement';
        el.nextPanel.hidden = false;
      } else if (this.nextPrompt) {
        el.btnNext.textContent = this.nextPrompt.label;
        el.nextPanel.hidden = false;
      } else {
        el.nextPanel.hidden = true;
      }
      this.renderStatus();
    }

    renderStatus() {
      const v = this.view;
      if (!v) return;
      const { status } = this.el;
      const me = v.players[v.viewerId];
      const now = Date.now();
      const turnSecs = this.turnDeadline ? Math.max(0, Math.ceil((this.turnDeadline - now) / 1000)) : null;
      const nextSecs = this.nextDeadline ? Math.max(0, Math.ceil((this.nextDeadline - now) / 1000)) : null;
      const myTurn = !this.el.actionPanel.hidden;
      let text = '';

      if (myTurn) {
        const legal = v.legal;
        text = legal.canCall ? `À vous : ${fmt(legal.toCall)} à suivre · pot ${fmt(legal.potTotal)}` : 'À vous de jouer';
        if (turnSecs != null) text += ` · ${turnSecs} s`;
      } else if (v.phase === PHASE.HAND_OVER) {
        if (v.gameOver) text = me && me.place === 1 ? 'Vous avez gagné la partie !' : 'Partie terminée.';
        else if (me && me.eliminated) text = 'Vous n’avez plus de jetons : vous suivez la partie en spectateur.';
        else text = me && me.isWinner ? `Bien joué ! Vous remportez ${fmt(me.wonAmount)}.` : 'Main terminée.';
        if (!v.gameOver && nextSecs != null) text += ` Main suivante dans ${nextSecs} s.`;
      } else if (v.allInRunout) {
        text = 'Tapis ! Déroulement du tableau…';
      } else {
        const current = v.toAct >= 0 ? v.players[v.toAct] : null;
        let thinking = '';
        if (current && current.id === v.viewerId) {
          thinking = 'Envoi de votre action…';
        } else if (current) {
          const offline = current.kind === 'remote' && !current.connected;
          thinking = offline ? `${current.name} est déconnecté` : `${current.name} ${current.isHuman ? 'joue' : 'réfléchit'}…`;
          if (turnSecs != null && v.turn && v.turn.seat === current.id) thinking += ` (${turnSecs} s)`;
        }
        if (me && me.eliminated) text = `Spectateur · ${thinking}`;
        else if (me && me.folded) text = thinking ? `Vous êtes hors du coup · ${thinking}` : 'Vous êtes hors du coup';
        else text = thinking;
      }
      status.textContent = text;
      status.classList.toggle('your-turn', myTurn);
    }

    appendLog(entry) {
      if (!entry) return;
      const li = document.createElement('li');
      li.className = `log-${entry.kind}`;
      li.textContent = entry.text;
      const list = this.el.logList;
      list.appendChild(li);
      while (list.children.length > 500) list.removeChild(list.firstChild);
      list.scrollTop = list.scrollHeight;
    }

    /* ---------------------------------------------------------------- */
    /* Fin de partie                                                     */
    /* ---------------------------------------------------------------- */

    showEndScreen() {
      const v = this.view;
      const { el } = this;
      const ranking = v.ranking.map((r) => ({ player: v.players[r.id], place: r.place }));
      const mine = ranking.find((r) => r.player.id === v.viewerId);
      const myPlace = mine ? mine.place : null;
      const won = myPlace === 1;

      el.endIcon.textContent = won ? '🏆' : '🃏';
      el.endTitle.textContent = won ? 'Victoire !' : 'Partie terminée';
      el.endSubtitle.textContent = won
        ? `Vous avez remporté tous les jetons en ${v.handNumber} mains.`
        : `Vous terminez à la ${myPlace}e place sur ${v.players.length}, après ${v.handNumber} mains.`;

      el.endRanking.innerHTML = ranking.map(({ player, place }) => {
        const detail = player.eliminated ? `sorti à la main n°${player.eliminatedAt}` : chipsLabel(player.chips);
        const me = player.id === v.viewerId;
        return `<li class="${me ? 'me' : ''}"><span class="rank-place">${place}</span>` +
          `<span class="rank-name">${escapeHtml(player.name)}${me ? ' (vous)' : player.isHuman ? '' : ' 🤖'}</span>` +
          `<span class="rank-detail">${detail}</span></li>`;
      }).join('');

      // Boutons selon le mode
      el.endWait.hidden = this.mode !== 'client' || !!this.rankedGame;
      el.btnReplay.hidden = this.mode === 'client';
      el.btnReplay.textContent = this.mode === 'host' ? 'Nouvelle partie à cette table' : 'Rejouer';
      el.btnSettings.textContent = this.mode === 'solo' ? 'Changer les réglages' : this.mode === 'host' ? 'Fermer la table' : 'Quitter la table';
      if (this.rankedGame) {
        el.btnReplay.hidden = false;
        el.btnReplay.textContent = 'Nouvelle partie classée';
        el.btnSettings.textContent = 'Retour à l’accueil';
      }
      this.accountUi.renderEndLine();
      this.showScreen('end');
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    Poker.app = new PokerApp();
  });
})(window);
