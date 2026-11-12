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
    if (!look || typeof look !== 'object') return { avatar: null, frame: null };
    const prefix = avatarPrefix();
    const avatar = typeof look.avatar === 'string' && prefix && look.avatar.startsWith(prefix) &&
      /^[\w\-./%]+$/.test(look.avatar.slice(prefix.length)) && look.avatar.length < 400
      ? look.avatar
      : null;
    const frame = FRAME_IDS.has(look.frame) ? look.frame : null;
    return { avatar, frame };
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

  /**
   * Recadre la photo en carré (centre de l'image), la réduit à 256 × 256 et la compresse.
   * @returns {Promise<{blob:Blob, ext:string, type:string}>}
   */
  async function prepareAvatar(file) {
    if (!file || !/^image\//.test(file.type)) throw new Error('Choisissez une image (JPEG, PNG, WebP…).');
    if (file.size > MAX_SOURCE_BYTES) throw new Error('Image trop lourde (15 Mo maximum).');
    const img = await loadImage(file);
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    if (!side) throw new Error('Image illisible.');
    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);

    let blob = await canvasToBlob(canvas, 'image/webp', 0.85);
    if (blob && blob.type === 'image/webp') return { blob, ext: 'webp', type: 'image/webp' };
    blob = await canvasToBlob(canvas, 'image/jpeg', 0.88); // navigateurs sans WebP
    if (!blob) throw new Error('Impossible de préparer l’image.');
    return { blob, ext: 'jpg', type: 'image/jpeg' };
  }

  Poker.Looks = Object.freeze({ FRAMES, sanitize, avatarHtml, prepareAvatar, avatarPrefix });
})(typeof window !== 'undefined' ? window : globalThis);
