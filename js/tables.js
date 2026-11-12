/**
 * tables.js — Tables publiques : liste dans l'onglet « Rejoindre » de l'accueil.
 *
 * Une table créée en « Publique » est inscrite dans l'annuaire (supabase/schema.sql,
 * open_tables) par son hôte (ui.js). Ici, on affiche les tables qui ont encore de la
 * place ; un clic sur « Rejoindre » utilise le même chemin qu'un code saisi à la main.
 */
(function (root) {
  'use strict';

  const Poker = root.Poker;
  const Account = Poker.Account;
  const Looks = Poker.Looks;

  const REFRESH_MS = 5000;
  const DIFFICULTY_NAMES = { facile: 'facile', moyen: 'moyen', difficile: 'difficile' };

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function plural(n, word) {
    return `${n} ${word}${n > 1 ? 's' : ''}`;
  }

  class PublicTablesUI {
    /** @param {PokerApp} app application principale (ui.js) */
    constructor(app) {
      this.app = app;
      const byId = (id) => document.getElementById(id);
      this.el = {
        list: byId('pt-list'),
        refresh: byId('btn-pt-refresh'),
        visibilityHint: byId('visibility-hint'),
        publicRadio: app.el.form.querySelector('input[name="visibility"][value="public"]'),
      };
      this.loading = false;
      this.loadedOnce = false;

      this.el.refresh.addEventListener('click', () => this.load());
      this.el.list.addEventListener('click', (event) => {
        const button = event.target.closest('[data-code]');
        if (button) this.app.joinFromList(button.dataset.code);
      });
      app.el.form.addEventListener('change', () => this.update());
      // Actualisation automatique tant que l'onglet « Rejoindre » est affiché
      setInterval(() => { if (this.visible()) this.load(); }, REFRESH_MS);
      Account.ready.then(() => this.update());
      this.update();
    }

    visible() {
      return this.app.activeScreen === 'home' && this.app.homeMode === 'join' && !document.hidden;
    }

    /** Onglet changé : texte d'aide de la visibilité, chargement de la liste. */
    update() {
      const available = Account.configured;
      this.el.publicRadio.disabled = !available;
      if (!available && this.el.publicRadio.checked) {
        this.app.el.form.querySelector('input[name="visibility"][value="private"]').checked = true;
      }
      const isPublic = this.el.publicRadio.checked;
      this.el.visibilityHint.textContent = !available
        ? 'Les tables publiques ne sont pas disponibles sur ce site : partagez le code de votre table.'
        : isPublic
          ? 'Votre table apparaîtra dans la liste « Rejoindre » : n’importe qui peut s’y asseoir tant qu’il reste de la place.'
          : 'Seules les personnes à qui vous donnez le code (ou le lien) peuvent rejoindre.';
      if (this.visible() && !this.loadedOnce) this.load();
    }

    async load() {
      if (this.loading) return;
      const { list } = this.el;
      if (!Account.configured) {
        list.innerHTML = '<li class="pt-empty">La liste des tables publiques n’est pas disponible sur ce site. Entrez le code d’une table ci-dessous.</li>';
        return;
      }
      this.loading = true;
      if (!this.loadedOnce) list.innerHTML = '<li class="pt-empty">Chargement des tables…</li>';
      try {
        const tables = await Account.listTables();
        this.render(tables);
        this.loadedOnce = true;
      } catch (error) {
        list.innerHTML = `<li class="pt-empty pt-error">${escapeHtml(error.message)}</li>`;
      } finally {
        this.loading = false;
      }
    }

    render(tables) {
      if (!tables.length) {
        this.el.list.innerHTML = '<li class="pt-empty">Aucune table publique pour le moment. ' +
          'Créez-en une : onglet « Créer », visibilité « Publique ».</li>';
        return;
      }
      this.el.list.innerHTML = tables.map((t) => {
        const look = { avatar: Account.publicAvatarUrl(t.avatar_path), frame: t.frame, title: t.title };
        const title = t.has_account ? Looks.titleName(t.title) : null;
        const bots = t.bots > 0 ? ` · ${plural(t.bots, 'bot')} (${DIFFICULTY_NAMES[t.difficulty] || t.difficulty})` : '';
        return `<li class="pt-row">` +
          Looks.avatarHtml({ name: t.host_pseudo, look, variant: 'person' }) +
          `<span class="pt-info"><strong>Table de ${escapeHtml(t.host_pseudo)}</strong>` +
          `${title ? `<em class="player-title">${escapeHtml(title)}</em>` : ''}` +
          `<small>${plural(t.players, 'joueur')}${bots} · ${plural(t.free_seats, 'place')} libre${t.free_seats > 1 ? 's' : ''}</small></span>` +
          `<button type="button" class="btn btn-primary btn-small" data-code="${escapeHtml(t.code)}">Rejoindre</button></li>`;
      }).join('');
    }
  }

  Poker.PublicTablesUI = PublicTablesUI;
})(typeof window !== 'undefined' ? window : globalThis);
