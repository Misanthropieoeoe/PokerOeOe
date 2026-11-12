/**
 * shop.js — Boutique : achat de cadres avec les jetons fictifs du compte.
 *
 * Les prix affichés viennent de Poker.Looks.FRAMES ; le serveur (buy_frame dans
 * supabase/schema.sql) vérifie le prix et le solde, débite les jetons et enregistre
 * le cadre. Un achat se fait en deux clics (« Acheter » puis « Confirmer »).
 */
(function (root) {
  'use strict';

  const Poker = root.Poker;
  const Account = Poker.Account;
  const Looks = Poker.Looks;
  const fmt = Poker.formatChips;

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  class ShopDialog {
    constructor(app) {
      this.app = app;
      const byId = (id) => document.getElementById(id);
      this.dialog = byId('shop-dialog');
      this.el = {
        balance: byId('shop-balance'),
        notice: byId('shop-notice'),
        grid: byId('shop-grid'),
        error: byId('shop-error'),
        success: byId('shop-success'),
      };
      this.confirming = null; // cadre en attente de confirmation d'achat
      this.busy = false;

      document.querySelectorAll('[data-open-shop]').forEach((button) => button.addEventListener('click', () => this.open()));
      byId('btn-shop-close').addEventListener('click', () => this.close());
      this.dialog.addEventListener('click', (event) => {
        if (event.target === this.dialog) this.close();
      });
      this.dialog.addEventListener('close', () => { this.confirming = null; });
      this.el.grid.addEventListener('click', (event) => {
        const button = event.target.closest('[data-shop-action]');
        if (button && !this.busy) this.act(button.dataset.shopAction, button.dataset.frame);
      });
      byId('shop-login').addEventListener('click', () => {
        this.close();
        this.app.accountUi.openAuth('login');
      });
      Account.onChange(() => { if (this.dialog.open) this.render(); });
    }

    open() {
      this.confirming = null;
      this.message('');
      this.render();
      if (typeof this.dialog.showModal === 'function') this.dialog.showModal();
      else this.dialog.setAttribute('open', '');
      // Solde à jour (partie jouée sur un autre appareil, jetons ajoutés…)
      if (Account.signedIn) Account.refreshProfile().then(() => this.render()).catch(() => {});
    }

    close() {
      if (typeof this.dialog.close === 'function') this.dialog.close();
      else this.dialog.removeAttribute('open');
    }

    message(text, success = false) {
      this.el.error.hidden = success || !text;
      this.el.success.hidden = !success || !text;
      (success ? this.el.success : this.el.error).textContent = text;
    }

    render() {
      const { el } = this;
      const p = Account.profile;
      const signedIn = Account.signedIn;
      el.balance.textContent = signedIn ? `${fmt(p.chips)} jetons` : '—';
      el.notice.hidden = signedIn;
      document.getElementById('shop-notice-text').textContent = Account.configured
        ? 'Connectez-vous avec un compte pour acheter des cadres avec vos jetons.'
        : 'La boutique n’est pas disponible sur ce site (comptes non configurés).';
      document.getElementById('shop-login').hidden = !Account.configured;

      const look = signedIn ? Account.look : null;
      const name = signedIn ? p.pseudo : 'Vous';
      el.grid.innerHTML = Looks.FRAMES.filter((f) => !f.exclusive || (signedIn && Looks.frameOwned(p, f))).map((frame) => {
        const owned = signedIn && Looks.frameOwned(p, frame);
        const worn = signedIn && (p.frame || 'or') === frame.id;
        let action;
        if (!signedIn) {
          action = `<span class="shop-price">${frame.price ? `${fmt(frame.price)} jetons` : 'Gratuit'}</span>`;
        } else if (worn) {
          action = '<span class="shop-state">✓ Porté</span>';
        } else if (owned) {
          action = `<button type="button" class="btn btn-ghost btn-small" data-shop-action="wear" data-frame="${frame.id}">Porter</button>`;
        } else if (this.confirming === frame.id) {
          action = `<button type="button" class="btn btn-primary btn-small" data-shop-action="confirm" data-frame="${frame.id}">Confirmer : ${fmt(frame.price)}</button>` +
            `<button type="button" class="link-button" data-shop-action="cancel" data-frame="${frame.id}">Annuler</button>`;
        } else {
          const affordable = p.chips >= frame.price;
          action = `<button type="button" class="btn ${affordable ? 'btn-primary' : 'btn-ghost'} btn-small" data-shop-action="buy" data-frame="${frame.id}"` +
            `${affordable ? '' : ' disabled'}>Acheter · ${fmt(frame.price)}</button>` +
            (affordable ? '' : `<span class="shop-missing">Il manque ${fmt(frame.price - p.chips)} jetons</span>`);
        }
        const tag = frame.exclusive ? '<span class="exclusive-tag">Exclusif</span>'
          : owned && frame.price ? '<span class="shop-owned">Acheté</span>'
            : !frame.price ? '<span class="shop-owned">Gratuit</span>' : '';
        return `<li class="shop-item${worn ? ' worn' : ''}${owned ? ' owned' : ''}">` +
          Looks.avatarHtml({ name, look: { avatar: look && look.avatar, frame: frame.id }, variant: 'me', className: 'shop-avatar' }) +
          `<strong>${escapeHtml(frame.name)}</strong>${tag}<div class="shop-action">${action}</div></li>`;
      }).join('');
    }

    async act(action, frameId) {
      const frame = Looks.FRAMES.find((f) => f.id === frameId);
      if (!frame) return;
      if (action === 'buy') {
        this.confirming = frameId;
        this.message('');
        this.render();
        return;
      }
      if (action === 'cancel') {
        this.confirming = null;
        this.render();
        return;
      }
      this.busy = true;
      this.message('');
      try {
        if (action === 'confirm') {
          await Account.buyFrame(frameId);
          this.message(`Cadre « ${frame.name} » acheté et porté ! Il reste ${fmt(Account.profile.chips)} jetons.`, true);
        } else if (action === 'wear') {
          await Account.setFrame(frameId);
          this.message(`Cadre « ${frame.name} » porté.`, true);
        }
      } catch (error) {
        this.message(error.message);
      } finally {
        this.busy = false;
        this.confirming = null;
        this.render();
        // Le message est en haut : on y remonte pour qu'il soit visible
        this.dialog.querySelector('.rules-body').scrollTo({ top: 0, behavior: 'smooth' });
      }
    }
  }

  Poker.ShopDialog = ShopDialog;
})(typeof window !== 'undefined' ? window : globalThis);
