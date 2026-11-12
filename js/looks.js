/**
 * looks.js — Apparence des joueurs : cadres de couleur et photos de profil.
 *
 * Une « apparence » est un objet { avatar, frame } :
 *   - avatar : adresse publique de la photo (stockage Supabase « avatars »), ou null ;
 *   - frame  : identifiant de cadre (voir FRAMES), ou null pour un avatar simple.
 * Elle voyage aussi sur le réseau en multijoueur : sanitize() n'accepte que des
 * cadres connus et des photos venant du stockage du projet.
 */
(function (root) {
  'use strict';

  const Poker = (root.Poker = root.Poker || {});

  /** Cadres proposés dans « Mon profil ». */
  const FRAMES = [
    { id: 'or', name: 'Or' },
    { id: 'argent', name: 'Argent' },
    { id: 'rubis', name: 'Rubis' },
    { id: 'emeraude', name: 'Émeraude' },
    { id: 'saphir', name: 'Saphir' },
    { id: 'amethyste', name: 'Améthyste' },
    { id: 'neon', name: 'Néon' },
    { id: 'arcenciel', name: 'Arc-en-ciel' },
  ];
  const FRAME_IDS = new Set(FRAMES.map((f) => f.id));

  /**
   * Titres affichés sous le pseudo, débloqués grâce aux statistiques.
   * Les conditions sont vérifiées aussi par la base (title_unlocked dans supabase/schema.sql).
   */
  const TITLES = [
    { id: 'debutant', name: 'Débutant', goal: 'Disponible dès l’inscription', stat: null, need: 0 },
    { id: 'habitue', name: 'Habitué', goal: 'Jouer 10 parties', stat: 'games_played', need: 10 },
    { id: 'veteran', name: 'Vétéran', goal: 'Jouer 50 parties', stat: 'games_played', need: 50 },
    { id: 'vainqueur', name: 'Vainqueur', goal: 'Gagner une partie', stat: 'wins', need: 1 },
    { id: 'requin', name: 'Requin', goal: 'Gagner 10 parties', stat: 'wins', need: 10 },
    { id: 'legende', name: 'Légende', goal: 'Gagner 50 parties', stat: 'wins', need: 50 },
    { id: 'main_heureuse', name: 'Main heureuse', goal: 'Gagner 100 mains', stat: 'hands_won', need: 100 },
    { id: 'gros_pot', name: 'Gros pot', goal: 'Remporter un pot de 3 000', stat: 'biggest_pot', need: 3000 },
    { id: 'flambeur', name: 'Flambeur', goal: 'Remporter un pot de 5 000', stat: 'biggest_pot', need: 5000 },
    { id: 'phenix', name: 'Phénix', goal: 'Recharger son solde 5 fois', stat: 'refills', need: 5 },
    { id: 'riche', name: 'Riche', goal: 'Avoir 10 000 jetons', stat: 'chips', need: 10000 },
    { id: 'magnat', name: 'Magnat', goal: 'Avoir 50 000 jetons', stat: 'chips', need: 50000 },
  ];
  const TITLE_BY_ID = new Map(TITLES.map((t) => [t.id, t]));

  /** Le profil a-t-il débloqué ce titre ? */
  function titleUnlocked(profile, title) {
    return !!profile && (!title.stat || Number(profile[title.stat] || 0) >= title.need);
  }

  /** Nom d'un titre à partir de son identifiant (null si inconnu). */
  function titleName(id) {
    const title = TITLE_BY_ID.get(id);
    return title ? title.name : null;
  }

  const AVATAR_SIZE = 256;            // photo recadrée en 256 × 256
  const MAX_SOURCE_BYTES = 15 * 1024 * 1024;

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  /** Début des adresses de photos acceptées (stockage public du projet Supabase). */
  function avatarPrefix() {
    const url = Poker.config && Poker.config.supabaseUrl;
    return url ? url.replace(/\/+$/, '') + '/storage/v1/object/public/avatars/' : null;
  }

  /** Ne garde qu'un cadre connu et une photo du stockage du projet. */
  function sanitize(look) {
    if (!look || typeof look !== 'object') return { avatar: null, frame: null, title: null };
    const prefix = avatarPrefix();
    const avatar = typeof look.avatar === 'string' && prefix && look.avatar.startsWith(prefix) &&
      /^[\w\-./%]+$/.test(look.avatar.slice(prefix.length)) && look.avatar.length < 400
      ? look.avatar
      : null;
    const frame = FRAME_IDS.has(look.frame) ? look.frame : null;
    const title = TITLE_BY_ID.has(look.title) ? look.title : null;
    return { avatar, frame, title };
  }

  /**
   * Attributs HTML d'un avatar.
   * @param {Object} options
   * @param {string} options.name   pseudo (son initiale s'affiche sans photo)
   * @param {Object} [options.look] apparence { avatar, frame }
   * @param {string} [options.variant] 'me' | 'person' | 'bot' | 'host' (couleur de fond sans photo)
   * @param {string} [options.className] classes supplémentaires
   * @param {string} [options.content] contenu à la place de l'initiale (ex. 🤖)
   */
  function avatarHtml({ name, look, variant, className, content }) {
    const { avatar, frame } = sanitize(look);
    const classes = ['avatar', variant || '', className || '', avatar ? 'has-photo' : ''].filter(Boolean).join(' ');
    const style = avatar ? ` style="--photo: url('${escapeHtml(avatar)}')"` : '';
    const frameAttr = frame ? ` data-frame="${frame}"` : '';
    const label = content != null ? content : escapeHtml(String(name || '?').charAt(0).toUpperCase());
    return `<span class="${classes}"${frameAttr}${style} aria-hidden="true">${avatar ? '' : label}</span>`;
  }

  /** Lit une image choisie par le joueur. */
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image illisible : essayez une photo JPEG ou PNG.')); };
      img.src = url;
    });
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  }

  /** Vérifie et lit l'image choisie par le joueur. */
  async function readImageFile(file) {
    if (!file || !/^image\//.test(file.type)) throw new Error('Choisissez une image (JPEG, PNG, WebP…).');
    if (file.size > MAX_SOURCE_BYTES) throw new Error('Image trop lourde (15 Mo maximum).');
    const img = await loadImage(file);
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('Image illisible.');
    return img;
  }

  /**
   * Produit la photo finale (256 × 256, compressée) à partir d'une zone carrée de l'image.
   * @param {HTMLImageElement} img
   * @param {{x:number, y:number, size:number}} [crop] zone en pixels de l'image (centre par défaut)
   * @returns {Promise<{blob:Blob, ext:string, type:string}>}
   */
  async function exportAvatar(img, crop) {
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const area = crop || { x: (img.naturalWidth - side) / 2, y: (img.naturalHeight - side) / 2, size: side };
    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, area.x, area.y, area.size, area.size, 0, 0, AVATAR_SIZE, AVATAR_SIZE);

    let blob = await canvasToBlob(canvas, 'image/webp', 0.85);
    if (blob && blob.type === 'image/webp') return { blob, ext: 'webp', type: 'image/webp' };
    blob = await canvasToBlob(canvas, 'image/jpeg', 0.88); // navigateurs sans WebP
    if (!blob) throw new Error('Impossible de préparer l’image.');
    return { blob, ext: 'jpg', type: 'image/jpeg' };
  }

  /* ------------------------------------------------------------------ */
  /* Recadrage interactif                                                */
  /* ------------------------------------------------------------------ */

  /**
   * Fenêtre de recadrage : on fait glisser la photo (souris, doigt, flèches du clavier)
   * et on zoome (curseur, molette, pincement) ; le cercle montre ce qui sera visible.
   * open(img) renvoie la zone choisie { x, y, size } en pixels de l'image, ou null si annulé.
   */
  class Cropper {
    constructor(elements) {
      this.el = elements; // { dialog, stage, canvas, zoom, ok, cancel }
      this.ctx = elements.canvas.getContext('2d');
      this.size = elements.canvas.width; // côté du canevas (pixels internes)
      this.img = null;
      this.resolve = null;
      this.pointers = new Map();
      this.bind();
    }

    open(img) {
      this.img = img;
      this.base = Math.max(this.size / img.naturalWidth, this.size / img.naturalHeight); // l'image couvre le cadre
      this.zoom = 1;
      this.scale = this.base;
      this.x = (this.size - img.naturalWidth * this.scale) / 2;
      this.y = (this.size - img.naturalHeight * this.scale) / 2;
      this.el.zoom.value = '1';
      this.draw();
      this.el.dialog.hidden = false;
      this.el.stage.focus();
      return new Promise((resolve) => { this.resolve = resolve; });
    }

    close(result) {
      this.el.dialog.hidden = true;
      this.pointers.clear();
      const resolve = this.resolve;
      this.resolve = null;
      if (resolve) resolve(result);
    }

    /** Zone de l'image actuellement visible dans le cadre. */
    selection() {
      return { x: -this.x / this.scale, y: -this.y / this.scale, size: this.size / this.scale };
    }

    /** Empêche de laisser un vide : l'image couvre toujours tout le cadre. */
    clamp() {
      const w = this.img.naturalWidth * this.scale;
      const h = this.img.naturalHeight * this.scale;
      this.x = Math.min(0, Math.max(this.size - w, this.x));
      this.y = Math.min(0, Math.max(this.size - h, this.y));
    }

    /** Change le zoom en gardant fixe le point (cx, cy) du cadre. */
    setZoom(zoom, cx = this.size / 2, cy = this.size / 2) {
      const z = Math.max(1, Math.min(4, zoom));
      const imgX = (cx - this.x) / this.scale;
      const imgY = (cy - this.y) / this.scale;
      this.zoom = z;
      this.scale = this.base * z;
      this.x = cx - imgX * this.scale;
      this.y = cy - imgY * this.scale;
      this.el.zoom.value = String(z);
      this.draw();
    }

    move(dx, dy) {
      this.x += dx;
      this.y += dy;
      this.draw();
    }

    draw() {
      this.clamp();
      const { ctx, size, img } = this;
      ctx.clearRect(0, 0, size, size);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, this.x, this.y, img.naturalWidth * this.scale, img.naturalHeight * this.scale);
    }

    /** Pixels écran → pixels du canevas. */
    ratio() {
      const rect = this.el.canvas.getBoundingClientRect();
      return rect.width ? this.size / rect.width : 1;
    }

    bind() {
      const { stage, zoom, ok, cancel, dialog } = this.el;
      zoom.addEventListener('input', () => this.setZoom(Number(zoom.value)));
      ok.addEventListener('click', () => this.close(this.selection()));
      cancel.addEventListener('click', () => this.close(null));
      // Échap ferme la fenêtre, où que soit le focus
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !dialog.hidden) this.close(null);
      });

      stage.addEventListener('pointerdown', (event) => {
        stage.setPointerCapture(event.pointerId);
        this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      });
      stage.addEventListener('pointermove', (event) => {
        const previous = this.pointers.get(event.pointerId);
        if (!previous) return;
        const current = { x: event.clientX, y: event.clientY };
        const ratio = this.ratio();
        if (this.pointers.size === 2) {
          // Pincement : le zoom suit l'écart entre les deux doigts
          const other = [...this.pointers.entries()].find(([id]) => id !== event.pointerId)[1];
          const before = Math.hypot(previous.x - other.x, previous.y - other.y);
          const after = Math.hypot(current.x - other.x, current.y - other.y);
          const rect = this.el.canvas.getBoundingClientRect();
          const cx = ((current.x + other.x) / 2 - rect.left) * ratio;
          const cy = ((current.y + other.y) / 2 - rect.top) * ratio;
          if (before > 0) this.setZoom(this.zoom * (after / before), cx, cy);
        } else {
          this.move((current.x - previous.x) * ratio, (current.y - previous.y) * ratio);
        }
        this.pointers.set(event.pointerId, current);
      });
      const release = (event) => this.pointers.delete(event.pointerId);
      stage.addEventListener('pointerup', release);
      stage.addEventListener('pointercancel', release);

      stage.addEventListener('wheel', (event) => {
        event.preventDefault();
        const rect = this.el.canvas.getBoundingClientRect();
        const ratio = this.ratio();
        this.setZoom(this.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1), (event.clientX - rect.left) * ratio, (event.clientY - rect.top) * ratio);
      }, { passive: false });

      stage.addEventListener('keydown', (event) => {
        const step = 12;
        const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
        if (moves[event.key]) {
          event.preventDefault();
          this.move(...moves[event.key]);
        } else if (event.key === '+' || event.key === '=') {
          this.setZoom(this.zoom * 1.1);
        } else if (event.key === '-') {
          this.setZoom(this.zoom / 1.1);
        } else if (event.key === 'Enter') {
          this.close(this.selection());
        }
      });
    }
  }

  Poker.Looks = Object.freeze({
    FRAMES, TITLES, sanitize, avatarHtml, readImageFile, exportAvatar, avatarPrefix,
    titleUnlocked, titleName, Cropper,
  });
})(typeof window !== 'undefined' ? window : globalThis);
