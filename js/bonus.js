/**
 * bonus.js — Bonus horaire : 250 jetons à récupérer toutes les heures (comptes uniquement).
 *
 * Le serveur fait foi (claim_bonus / bonus_wait dans supabase/schema.sql) : il garde la date
 * de la dernière récupération et refuse un nouveau bonus avant une heure, quelle que soit
 * l'horloge de l'appareil. Le bouton « 🎁 » de la barre de compte brille quand c'est prêt.
 */
(function (root) {
  'use strict';

  const Poker = root.Poker;
  const Account = Poker.Account;
  const fmt = Poker.formatChips;

  function clock(seconds) {
    const s = Math.max(0, Math.ceil(seconds));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }

  class BonusDialog {
    constructor(app) {
      this.app = app;
      const byId = (id) => document.getElementById(id);
      this.dialog = byId('bonus-dialog');
      this.el = {
        text: byId('bonus-text'),
        timer: byId('bonus-timer'),
        claim: byId('btn-bonus-claim'),
        error: byId('bonus-error'),
        success: byId('bonus-success'),
      };
      this.deadline = null;   // moment local où le bonus redevient disponible
      this.ticker = null;
      this.busy = false;
      this.lastReady = null;

      byId('btn-bonus-close').addEventListener('click', () => this.close());
      this.dialog.addEventListener('click', (event) => { if (event.target === this.dialog) this.close(); });
      this.dialog.addEventListener('close', () => this.stopTicker());
      this.el.claim.addEventListener('click', () => this.onClaimClick());

      // Le bouton de la barre de compte se met à briller dès que le bonus est de nouveau prêt
      setInterval(() => {
        const ready = Account.bonusReady;
        if (ready !== this.lastReady) {
          this.lastReady = ready;
          this.app.accountUi.renderBar();
        }
      }, 15000);
    }

    async open() {
      this.message('');
      this.dialog.classList.remove('claimed');
      if (typeof this.dialog.showModal === 'function') this.dialog.showModal();
      else this.dialog.setAttribute('open', '');

      if (!Account.signedIn) {
        this.deadline = null;
        this.el.text.textContent = Account.configured
          ? 'Le bonus horaire est réservé aux comptes : connectez-vous ou créez un compte gratuit.'
          : 'Le bonus horaire n’est pas disponible sur ce site.';
        this.el.timer.textContent = '';
        this.el.claim.textContent = 'Se connecter';
        this.el.claim.disabled = !Account.configured;
        return;
      }
      this.el.text.textContent = 'Toutes les heures, récupérez 250 jetons gratuits.';
      this.el.claim.textContent = 'Récupérer 250 jetons';
      this.el.claim.disabled = true;
      this.el.timer.textContent = 'Vérification…';
      try {
        this.setWait(await Account.bonusWait());
      } catch (error) {
        this.el.timer.textContent = '';
        this.message(error.message);
      }
    }

    close() {
      if (typeof this.dialog.close === 'function') this.dialog.close();
      else this.dialog.removeAttribute('open');
      this.stopTicker();
    }

    stopTicker() {
      if (this.ticker) clearInterval(this.ticker);
      this.ticker = null;
    }

    /** Démarre le compte à rebours (secondes renvoyées par le serveur). */
    setWait(seconds) {
      this.deadline = Date.now() + seconds * 1000;
      this.stopTicker();
      this.tick();
      this.ticker = setInterval(() => this.tick(), 1000);
    }

    tick() {
      const left = (this.deadline - Date.now()) / 1000;
      const ready = left <= 0;
      if (!this.busy) this.el.claim.disabled = !ready;
      this.el.timer.textContent = ready ? 'Votre bonus est prêt !' : `Prochain bonus dans ${clock(left)}`;
      this.el.timer.classList.toggle('ready', ready);
    }

    message(text, success = false) {
      this.el.error.hidden = success || !text;
      this.el.success.hidden = !success || !text;
      (success ? this.el.success : this.el.error).textContent = text;
    }

    async onClaimClick() {
      if (!Account.signedIn) {
        this.close();
        this.app.accountUi.openAuth('login');
        return;
      }
      if (this.busy) return;
      this.busy = true;
      this.el.claim.disabled = true;
      this.message('');
      try {
        const profile = await Account.claimBonus();
        this.dialog.classList.add('claimed'); // petite animation des jetons
        this.message(`+250 jetons ! Nouveau solde : ${fmt(profile.chips)} jetons.`, true);
        this.setWait(3600);
      } catch (error) {
        this.message(error.message);
        // Le serveur a refusé (trop tôt) : on resynchronise le compte à rebours
        Account.bonusWait().then((s) => this.setWait(s)).catch(() => {});
      } finally {
        this.busy = false;
        this.tick();
        this.lastReady = Account.bonusReady;
        this.app.accountUi.renderBar();
      }
    }
  }

  Poker.BonusDialog = BonusDialog;
})(typeof window !== 'undefined' ? window : globalThis);
