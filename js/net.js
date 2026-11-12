/**
 * net.js — Couche réseau du mode multijoueur (WebRTC via PeerJS).
 *
 * Principe : le navigateur qui crée la table (l'« hôte ») fait tourner le moteur
 * de jeu. Les autres joueurs s'y connectent directement grâce à un code de table.
 * Le serveur public de PeerJS ne sert qu'à mettre les navigateurs en relation ;
 * les données de jeu passent ensuite directement d'un appareil à l'autre.
 *
 * La bibliothèque PeerJS (js/vendor/peerjs.min.js) n'est chargée qu'à la
 * première utilisation du mode en ligne : le mode solo reste 100 % hors ligne.
 *
 * Paramètres d'URL (tests / serveur PeerJS personnel) :
 *   ?peerhost=localhost&peerport=9000&peerpath=/&peersecure=0
 */
(function (root) {
  'use strict';

  const Poker = (root.Poker = root.Poker || {});

  const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sans I, L, O, 0, 1 (ambigus)
  const CODE_LENGTH = 5;
  const ID_PREFIX = 'holdem-fr-v1-';
  const LIBRARY_SRC = 'js/vendor/peerjs.min.js';
  const CONNECT_TIMEOUT_MS = 15000;

  const ERROR_MESSAGES = {
    'peer-unavailable': 'Table introuvable : vérifiez le code, ou l’hôte a peut-être fermé la table.',
    network: 'Impossible de joindre le serveur de mise en relation. Vérifiez votre connexion Internet.',
    'socket-error': 'Impossible de joindre le serveur de mise en relation. Vérifiez votre connexion Internet.',
    'socket-closed': 'La connexion au serveur de mise en relation a été coupée.',
    'server-error': 'Le serveur de mise en relation ne répond pas. Réessayez dans un instant.',
    'browser-incompatible': 'Ce navigateur ne permet pas le jeu en ligne (WebRTC indisponible).',
    'unavailable-id': 'Ce code de table est déjà utilisé.',
    webrtc: 'La connexion directe entre les appareils a échoué (réseau trop restrictif).',
  };

  function describeError(error) {
    if (error && ERROR_MESSAGES[error.type]) return ERROR_MESSAGES[error.type];
    return 'Erreur de connexion' + (error && error.message ? ' : ' + error.message : '.');
  }

  function randomCode() {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[Poker.Cards.randomInt(CODE_ALPHABET.length)];
    return code;
  }

  /** Nettoie un code saisi : majuscules, sans espaces ni symboles. */
  function normalizeCode(text) {
    return String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  }

  /** Options PeerJS (serveur public par défaut, ou serveur indiqué dans l'URL). */
  function peerOptions() {
    const params = new URLSearchParams(root.location.search);
    const options = { debug: 0 };
    if (params.get('peerhost')) {
      options.host = params.get('peerhost');
      options.port = Number(params.get('peerport') || 9000);
      options.path = params.get('peerpath') || '/';
      options.secure = params.get('peersecure') === '1';
    }
    return options;
  }

  let libraryPromise = null;

  /** Charge PeerJS à la demande (script local, aucun CDN). */
  function loadLibrary() {
    if (root.Peer) return Promise.resolve(root.Peer);
    if (!libraryPromise) {
      libraryPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = LIBRARY_SRC;
        script.onload = () => (root.Peer ? resolve(root.Peer) : reject(new Error('Module réseau indisponible.')));
        script.onerror = () => {
          libraryPromise = null;
          reject(new Error('Impossible de charger le module réseau (js/vendor/peerjs.min.js).'));
        };
        document.head.appendChild(script);
      });
    }
    return libraryPromise;
  }

  /** Ouvre une connexion au serveur de mise en relation (avec un identifiant imposé ou non). */
  function openPeer(Peer, id) {
    return new Promise((resolve, reject) => {
      const peer = id ? new Peer(id, peerOptions()) : new Peer(peerOptions());
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        peer.destroy();
        reject({ type: 'network' });
      }, CONNECT_TIMEOUT_MS);
      peer.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(peer);
      });
      peer.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        peer.destroy();
        reject(error);
      });
    });
  }

  /** Si le lien avec le serveur de mise en relation tombe, on le rétablit (les parties en cours continuent). */
  function keepSignalingAlive(peer) {
    peer.on('disconnected', () => {
      setTimeout(() => {
        if (!peer.destroyed && peer.disconnected) {
          try { peer.reconnect(); } catch (e) { /* nouvel essai au prochain événement */ }
        }
      }, 1500);
    });
  }

  /** Petit émetteur d'événements. */
  class Emitter {
    constructor() { this.handlers = {}; }
    on(event, fn) { (this.handlers[event] = this.handlers[event] || []).push(fn); return this; }
    emit(event, ...args) { (this.handlers[event] || []).forEach((fn) => fn(...args)); }
  }

  /**
   * Côté hôte : publie la table sous un code et accepte les connexions.
   * Événements : 'connect' (conn), 'message' (conn, data), 'disconnect' (conn), 'error' (texte).
   */
  class HostNetwork extends Emitter {
    static async create() {
      const Peer = await loadLibrary();
      for (let attempt = 0; attempt < 4; attempt++) {
        const code = randomCode();
        try {
          const peer = await openPeer(Peer, ID_PREFIX + code);
          return new HostNetwork(peer, code);
        } catch (error) {
          if (!error || error.type !== 'unavailable-id') throw new Error(describeError(error));
        }
      }
      throw new Error('Impossible de créer une table, réessayez.');
    }

    constructor(peer, code) {
      super();
      this.peer = peer;
      this.code = code;
      this.connections = new Set();
      keepSignalingAlive(peer);

      peer.on('connection', (conn) => {
        const drop = () => {
          if (this.connections.delete(conn)) this.emit('disconnect', conn);
        };
        conn.on('open', () => {
          this.connections.add(conn);
          this.emit('connect', conn);
        });
        conn.on('data', (data) => this.emit('message', conn, data));
        conn.on('close', drop);
        conn.on('error', drop);
      });
      peer.on('error', (error) => {
        // Les erreurs « peer-unavailable » concernent un joueur parti : sans gravité pour l'hôte.
        if (error && error.type !== 'peer-unavailable') this.emit('error', describeError(error));
      });
    }

    send(conn, message) {
      if (!conn || !conn.open) return;
      try { conn.send(message); } catch (e) { /* connexion en cours de fermeture */ }
    }

    close(conn) {
      try { conn.close(); } catch (e) { /* déjà fermée */ }
    }

    destroy() {
      this.connections.clear();
      if (!this.peer.destroyed) this.peer.destroy();
    }
  }

  /**
   * Côté invité : se connecte à la table d'un hôte.
   * Événements : 'message' (data), 'close'.
   */
  class ClientNetwork extends Emitter {
    static async connect(code) {
      const Peer = await loadLibrary();
      let peer;
      try {
        peer = await openPeer(Peer, null);
      } catch (error) {
        throw new Error(describeError(error));
      }
      return new Promise((resolve, reject) => {
        const conn = peer.connect(ID_PREFIX + code, { reliable: true, serialization: 'json' });
        let settled = false;
        const fail = (message) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          peer.destroy();
          reject(new Error(message));
        };
        const timer = setTimeout(() => fail('La table ne répond pas. Vérifiez le code, ou réessayez.'), CONNECT_TIMEOUT_MS);
        peer.on('error', (error) => fail(describeError(error)));
        conn.on('open', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(new ClientNetwork(peer, conn, code));
        });
      });
    }

    constructor(peer, conn, code) {
      super();
      this.peer = peer;
      this.conn = conn;
      this.code = code;
      this.closed = false;
      keepSignalingAlive(peer);
      const onClose = () => {
        if (this.closed) return;
        this.closed = true;
        this.emit('close');
      };
      conn.on('data', (data) => this.emit('message', data));
      conn.on('close', onClose);
      conn.on('error', onClose);
    }

    send(message) {
      if (!this.conn.open) return;
      try { this.conn.send(message); } catch (e) { /* connexion en cours de fermeture */ }
    }

    destroy() {
      this.closed = true;
      if (!this.peer.destroyed) this.peer.destroy();
    }
  }

  Poker.Net = Object.freeze({ HostNetwork, ClientNetwork, normalizeCode, loadLibrary, CODE_LENGTH });
})(typeof window !== 'undefined' ? window : globalThis);
