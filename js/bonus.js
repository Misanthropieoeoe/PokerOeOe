/**
 * bonus.js — Bonus horaire : 250 jetons par heure, cumulables jusqu'à 8 (comptes uniquement).
 *
 * Le serveur fait foi (bonus_status / claim_bonus dans supabase/schema.sql) : il calcule
 * le nombre de bonus accumulés depuis la dernière récupération, selon sa propre horloge.
 * Le bouton « 🎁 » de la barre de compte brille et affiche le nombre (×3) quand c'est prêt.
 */
(function (root) {
  'use strict';

  const Poker = root.Poker;
  const Account = Poker.Account;
  const fmt = Poker.formatChips;

  const AMOUNT = 250;
  const MAX = 8;

  function clock(seconds) {
    const s = Math.max(0, Math.ceil(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }

  class BonusDialog {
    constructor(app) {
      this.app = app;
      const byId = (id) => document.getElementById(id);
      this.dialog = byId('bonus-dialog');
      this.el = {
        amount: byId('bonus-amount'),
        pips: byId('bonus-pips'),
        count: byId('bonus-count'),
        text: byId('bonus-text'),
        timer: byId('bonus-timer'),
        claim: byId('btn-bonus-claim'),
        error: byId('bonus-error'),
        success: byId('bonus-success'),
      };
      this.state = null;   // { available, nextAt } : nextAt = moment local du prochain bonus (null au maximum)
      this.ticker = null;
      this.busy = false;
      this.lastCount = null;

      byId('btn-bonus-close').addEventListener('click', () => this.close());
      this.dialog.addEventListener('click', (event) => { if (event.target === this.dialog) this.close(); });
      this.dialog.addEventListener('close', () => this.stopTicker());
      this.el.claim.addEventListener('click', () => this.onClaimClick());

      // Le bouton de la barre de compte suit l'accumulation (×2, ×3…)
      setInterval(() => {
        const count = Account.bonusCount;
        if (count !== this.lastCount) {
          this.lastCount = count;
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
        this.state = null;
        this.el.amount.textContent = `+${AMOUNT}`;
        this.el.pips.innerHTML = '';
        this.el.count.textContent = '';
        this.el.text.textContent = Account.configured
          ? 'Le bonus horaire est réservé aux comptes : connectez-vous ou créez un compte gratuit.'
          : 'Le bonus horaire n’est pas disponible sur ce site.';
        this.el.timer.textContent = '';
        this.el.claim.textContent = 'Se connecter';
        this.el.claim.disabled = !Account.configured;
        return;
      }
      this.el.text.textContent = `${AMOUNT} jetons gratuits s’accumulent chaque heure, jusqu’à ${MAX} (${fmt(AMOUNT * MAX)} jetons).`;
      this.el.claim.disabled = true;
      this.el.timer.textContent = 'Vérification…';
      try {
        this.setStatus(await Account.bonusStatus());
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

    /** État renvoyé par le serveur : { available, next_in }. */
    setStatus(status) {
      const nextIn = status && status.next_in;
      this.state = {
        available: Number(status && status.available) || 0,
        nextAt: nextIn == null ? null : Date.now() + Number(nextIn) * 1000,
      };
      this.stopTicker();
      this.tick();
      this.ticker = setInterval(() => this.tick(), 1000);
    }

    tick() {
      const st = this.state;
      if (!st) return;
      // Pendant que la fenêtre est ouverte, un nouveau bonus peut s'ajouter
      while (st.nextAt !== null && Date.now() >= st.nextAt && st.available < MAX) {
        st.available++;
        st.nextAt = st.available >= MAX ? null : st.nextAt + 3600e3;
      }
      const n = st.available;
      this.el.amount.textContent = `+${fmt(AMOUNT * Math.max(1, n))}`;
      this.el.pips.innerHTML = Array.from({ length: MAX }, (_, i) => `<span class="${i < n ? 'on' : ''}"></span>`).join('');
      this.el.pips.setAttribute('aria-label', `${n} bonus accumulé${n > 1 ? 's' : ''} sur ${MAX}`);
      this.el.count.textContent = n === 0 ? 'Aucun bonus pour le moment' : `${n} bonus accumulé${n > 1 ? 's' : ''} sur ${MAX}`;
      if (!this.busy) {
        this.el.claim.disabled = n === 0;
        this.el.claim.textContent = n === 0 ? `Récupérer ${AMOUNT} jetons` : `Récupérer ${fmt(AMOUNT * n)} jetons`;
      }
      let timer;
      if (st.nextAt === null) timer = 'Maximum atteint : récupérez vos bonus pour continuer à en accumuler.';
      else timer = `${n === 0 ? 'Prochain bonus' : 'Bonus suivant'} dans ${clock((st.nextAt - Date.now()) / 1000)}`;
      this.el.timer.textContent = timer;
      this.el.timer.classList.toggle('ready', n > 0);
      this.el.timer.classList.toggle('full', st.nextAt === null);
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
      const before = Account.profile.chips;
      try {
        const profile = await Account.claimBonus();
        const gained = profile.chips - before;
        this.dialog.classList.remove('claimed');
        void this.dialog.offsetWidth; // relance l'animation des jetons
        this.dialog.classList.add('claimed');
        this.message(`+${fmt(gained)} jetons ! Nouveau solde : ${fmt(profile.chips)} jetons.`, true);
      } catch (error) {
        this.message(error.message);
      } finally {
        this.busy = false;
        try { this.setStatus(await Account.bonusStatus()); } catch (e) { this.tick(); }
        this.lastCount = Account.bonusCount;
        this.app.accountUi.renderBar();
      }
    }
  }

  Poker.BonusDialog = BonusDialog;
})(typeof window !== 'undefined' ? window : globalThis);
