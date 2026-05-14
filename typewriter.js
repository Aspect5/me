/**
 * Typewriter orchestrator.
 *
 * Drives the landing-page reveal: P.S. signature → name → nav → body cascade.
 * All timing lives in this file; all animation is WAAPI. CSS only owns static
 * visuals (starting opacity, layout). Content length changes retime the
 * sequence automatically.
 *
 * Public surface: `new Typewriter(opts).start()` (or `Typewriter.mount(opts)`).
 */

(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────────────
  // Timing config. Single source of truth — every downstream number derives
  // from these.
  // ─────────────────────────────────────────────────────────────────────────
  const DEFAULTS = {
    // ── P.S. signature ──
    // The signature animates characters and carets one after another. We
    // expose each offset here so CSS variables on the element can drive
    // @keyframes delays, keeping timing in one place.
    ps: {
      charOffsets:  [0.22, 0.40, 0.58, 0.76],  // c1, c2, c3, c4 appear times
      caretOffsets: [0.22, 0.40, 0.58, 0.76],  // k1-k4 appear times
      caretKillAt:  0.96,                      // when k4 caret disappears
      dotFadeAt:    null,                      // set dynamically to (endTime + gapAfterBody)
    },

    // ── Name: character-by-character ──
    nameStart: 0.95,
    charStep:  0.04,
    charStepFast: 0.018,

    // ── Gaps between phases ──
    gapBeforeNav:  0.08,
    gapBeforeBody: 0.08,
    gapAfterBody:  0.35,

    // ── Body cascade: word-by-word ──
    wordStep:      0.06,
    wordStepFast:  0.018,
    blockStagger:  0.045,
  };

  // ─────────────────────────────────────────────────────────────────────────
  // DOM splitters
  // ─────────────────────────────────────────────────────────────────────────

  /** Split `el`'s text into `<span class="tw-char">` per character. Idempotent. */
  function splitChars(el) {
    if (el.dataset.twSplit === 'chars') return [...el.querySelectorAll('.tw-char')];
    unsplit(el);
    const text = el.textContent;
    el.textContent = '';
    const spans = [];
    for (const ch of text) {
      const span = document.createElement('span');
      span.className = 'tw-char';
      span.appendChild(document.createTextNode(ch));
      appendCursor(span);
      el.appendChild(span);
      spans.push(span);
    }
    el.dataset.twSplit = 'chars';
    return spans;
  }

  /**
   * Split `el`'s descendants into word spans (.tw-word), preserving inline
   * structure. Links (`<a>`) are tagged .tw-link and inserted into the reveal
   * order just before their first contained word, so the link's border-bottom
   * lights up as typing enters it.
   *
   * Returns `[{ el, kind: 'word'|'link' }, ...]` in reveal order.
   */
  function splitWords(el) {
    if (el.dataset.twSplit === 'words') return readUnits(el);
    unsplit(el);
    const units = [];

    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        if (!node.nodeValue || !node.nodeValue.trim()) return;
        const frag = document.createDocumentFragment();
        const parts = node.nodeValue.match(/\s+|\S+/g) || [];
        for (const part of parts) {
          if (/^\s+$/.test(part)) {
            frag.appendChild(document.createTextNode(part));
          } else {
            const span = document.createElement('span');
            span.className = 'tw-word';
            span.appendChild(document.createTextNode(part));
            appendCursor(span);
            frag.appendChild(span);
            units.push({ el: span, kind: 'word' });
          }
        }
        node.parentNode.replaceChild(frag, node);
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.tagName === 'A') {
          const before = units.length;
          [...node.childNodes].forEach(walk);
          if (units.length > before) {
            node.classList.add('tw-link');
            units.splice(before, 0, { el: node, kind: 'link' });
          }
          return;
        }
        [...node.childNodes].forEach(walk);
      }
    };

    [...el.childNodes].forEach(walk);
    el.dataset.twSplit = 'words';
    return units;
  }

  /** Inject a `<span class="tw-cursor">` as the last child. Used for WAAPI cursor anim. */
  function appendCursor(unit) {
    const c = document.createElement('span');
    c.className = 'tw-cursor';
    c.setAttribute('aria-hidden', 'true');
    unit.appendChild(c);
  }

  /** Undo a previous split. */
  function unsplit(el) {
    el.querySelectorAll('.tw-cursor').forEach(c => c.remove());
    el.querySelectorAll('.tw-char, .tw-word').forEach(s => {
      s.replaceWith(document.createTextNode(s.textContent));
    });
    el.querySelectorAll('.tw-link').forEach(a => a.classList.remove('tw-link', 'tw-link-on'));
    el.normalize();
    delete el.dataset.twSplit;
  }

  /** Re-read units from an already-split element (for idempotency). */
  function readUnits(el) {
    const units = [];
    const seen = new WeakSet();
    const walk = (n) => {
      if (n.nodeType !== Node.ELEMENT_NODE) return;
      if (n.classList.contains('tw-link') && !seen.has(n)) {
        seen.add(n);
        units.push({ el: n, kind: 'link' });
      }
      if (n.classList.contains('tw-word')) {
        units.push({ el: n, kind: 'word' });
        return;
      }
      [...n.children].forEach(walk);
    };
    [...el.children].forEach(walk);
    return units;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Animation primitives
  // ─────────────────────────────────────────────────────────────────────────

  // Keyframes shared by every typed unit.
  const UNIT_FADE = [
    { opacity: 0, offset: 0 },
    { opacity: 1, offset: 1 },
  ];

  // Keyframes for the cursor bar: fully visible for most of one step, then fades.
  // Using a 0→1→1→0 shape so adjacent units' cursors chain without a flicker.
  const CURSOR_KEYS = [
    { opacity: 1, offset: 0 },
    { opacity: 1, offset: 0.85 },
    { opacity: 0, offset: 1 },
  ];

  // ─────────────────────────────────────────────────────────────────────────
  // Typewriter class
  // ─────────────────────────────────────────────────────────────────────────

  class Typewriter {
    constructor(opts = {}) {
      this.config = this._mergeConfig(DEFAULTS, opts.config || {});
      this.psEl = opts.psEl || null;
      this.nameEl = opts.nameEl || null;
      this.navEls = opts.navEls ? [...opts.navEls] : [];
      this.bodyRoot = opts.bodyRoot || null;

      this.revealedTabs = new Set();
      this.activeAnimations = new Map(); // tabId → Animation[]
      this.endTime = 0;
      this._started = false;
    }

    _mergeConfig(base, over) {
      const out = { ...base, ...over };
      out.ps = { ...base.ps, ...(over.ps || {}) };
      return out;
    }

    /** Start the full reveal sequence. Idempotent. */
    start() {
      if (this._started) return;
      this._started = true;

      const c = this.config;
      let t = 0;

      // ── Phase 0: P.S. signature ──
      // The signature is CSS-keyframe driven; we just stamp the CSS custom
      // properties from our config so the single source of truth wins.
      if (this.psEl) {
        this._setupPsSignature(this.psEl);
      }

      // ── Phase 1: Name ──
      t = c.nameStart;
      if (this.nameEl) {
        const chars = splitChars(this.nameEl);
        const anims = this._revealSequence(chars, t, c.charStep);
        this._track('_name', anims);
        t += chars.length * c.charStep;
      }

      // ── Phase 2: Nav ──
      t += c.gapBeforeNav;
      if (this.navEls.length) {
        // All nav links share one continuous char stream so the cursor
        // flows left→right across them.
        const allChars = [];
        this.navEls.forEach(link => {
          splitChars(link).forEach(ch => allChars.push(ch));
        });
        const anims = this._revealSequence(allChars, t, c.charStep);
        this._track('_nav', anims);
        t += allChars.length * c.charStep;
      }

      // ── Phase 3: Body cascade (active tab) ──
      t += c.gapBeforeBody;
      if (this.bodyRoot) {
        const end = this._planCascade(this.bodyRoot, t, {
          wordStep: c.wordStep,
          blockStagger: c.blockStagger,
        });
        this.revealedTabs.add(this.bodyRoot.id);
        t = end;
      }

      // ── Phase 4: Finish the P.S. signature (dots fade + caret kill)
      // Now that we know when body ends, schedule the dot fade.
      if (this.psEl) {
        this._finishPsSignature(this.psEl, t + c.gapAfterBody);
      }

      // All content has been split into opacity:0 spans; safe to drop the
      // pre-hide that was protecting against the first-paint flash.
      document.documentElement.classList.remove('js-anim');

      this.endTime = t;
    }

    /** Switch to tab: replay cascade if never shown, skip if already shown. */
    showTab(tabId) {
      const tab = document.getElementById(tabId);
      if (!tab) return;

      // Cancel any in-flight animations on other tabs so they don't keep
      // running invisibly.
      this._cancelAllExcept(tabId);

      if (this.revealedTabs.has(tabId)) {
        this._forceRevealed(tab);
        return;
      }
      const c = this.config;
      this._planCascade(tab, 0.05, {
        wordStep: c.wordStepFast,
        blockStagger: c.blockStagger / 2,
      });
      this.revealedTabs.add(tabId);
    }

    // ── Internals ──

    _track(key, anims) {
      const list = this.activeAnimations.get(key) || [];
      anims.forEach(a => list.push(a));
      this.activeAnimations.set(key, list);
    }

    _cancelAllExcept(keepKey) {
      for (const [k, anims] of this.activeAnimations) {
        if (k === keepKey) continue;
        // Keys starting with `_` (_name, _nav) are one-shot reveals that
        // must stay put forever. Also: skip already-finished animations —
        // cancelling a finished `fill: forwards` anim reverts its element
        // to the start state (opacity 0), which would un-type the content.
        if (k.startsWith('_')) continue;
        anims.forEach(a => {
          if (a.playState === 'finished') return;
          try { a.cancel(); } catch {}
        });
      }
    }

    /** Reveal a flat list of units starting at `startSec`, one per `stepSec`. */
    _revealSequence(els, startSec, stepSec) {
      const anims = [];
      els.forEach((el, i) => {
        const at = startSec + i * stepSec;
        anims.push(...this._revealUnit(el, at, stepSec));
      });
      return anims;
    }

    /**
     * Reveal one unit: fade its opacity 0→1 at `delaySec`, then blink its
     * cursor for `stepSec`. Returns the Animation objects (trackable).
     */
    _revealUnit(el, delaySec, stepSec) {
      const anims = [];
      anims.push(el.animate(UNIT_FADE, {
        duration: 1,
        delay: delaySec * 1000,
        fill: 'forwards',
      }));
      const cursor = el.querySelector(':scope > .tw-cursor');
      if (cursor) {
        anims.push(cursor.animate(CURSOR_KEYS, {
          duration: stepSec * 1000,
          delay: delaySec * 1000,
          fill: 'forwards',
        }));
      }
      return anims;
    }

    /**
     * Plan a block-level cascade on `root`. Each direct child is a block
     * (<p>/<h2>/<li>). Blocks are kept chrome-hidden (`.tw-block-hidden`)
     * until their first word reveals, which suppresses flex-laid
     * pseudo-element rules (h2 dashed underline, § glyph).
     */
    _planCascade(root, startSec, { wordStep, blockStagger }) {
      const blocks = [];
      root.querySelectorAll(':scope > *').forEach(child => {
        if (child.tagName === 'UL') {
          child.querySelectorAll(':scope > li').forEach(li => blocks.push(li));
        } else {
          blocks.push(child);
        }
      });

      const allAnims = [];
      let t = startSec;
      blocks.forEach((block, blockIndex) => {
        const units = splitWords(block);
        if (units.length === 0) return;

        block.classList.add('tw-block-hidden');
        const chromeAt = t + blockIndex * blockStagger;

        // Flip the block from hidden → visible at the right moment. We use a
        // WAAPI animation whose `finish` event flips the class — this keeps
        // the timeline in one system, avoiding setTimeout drift.
        const blockAnim = block.animate(
          [{ visibility: 'hidden' }, { visibility: 'visible' }],
          { duration: 1, delay: chromeAt * 1000, fill: 'forwards' }
        );
        blockAnim.onfinish = () => block.classList.remove('tw-block-hidden');
        allAnims.push(blockAnim);

        // Reveal each word/link in sequence. Links share their delay with
        // the word they precede, so the border-bottom appears *with* the
        // first character of the link's text — not before it.
        let wordIndex = 0;
        units.forEach((u) => {
          if (u.kind === 'link') {
            // Use the upcoming word's delay (same wordIndex, not yet incremented).
            const at = t + blockIndex * blockStagger + wordIndex * wordStep;
            const linkAnim = u.el.animate(
              [{ opacity: 1 }, { opacity: 1 }],
              { duration: 1, delay: at * 1000, fill: 'forwards' }
            );
            linkAnim.onfinish = () => u.el.classList.add('tw-link-on');
            allAnims.push(linkAnim);
          } else {
            const at = t + blockIndex * blockStagger + wordIndex * wordStep;
            allAnims.push(...this._revealUnit(u.el, at, wordStep));
            wordIndex++;
          }
        });
        t += wordIndex * wordStep;
      });

      this._track(root.id || '_body', allAnims);
      return t + blocks.length * blockStagger;
    }

    /** Force every unit on `root` to its final state, cancelling pending anims. */
    _forceRevealed(root) {
      this._cancelPending(root);
      root.querySelectorAll('.tw-block-hidden').forEach(b => b.classList.remove('tw-block-hidden'));
      root.querySelectorAll('.tw-word, .tw-char').forEach(u => { u.style.opacity = '1'; });
      root.querySelectorAll('.tw-cursor').forEach(c => { c.style.opacity = '0'; });
      root.querySelectorAll('.tw-link').forEach(a => a.classList.add('tw-link-on'));
      root.querySelectorAll(':scope *').forEach(el => { if (el.style.visibility === 'hidden') el.style.visibility = 'visible'; });
    }

    /** Cancel every animation that targets any descendant of `root`. */
    _cancelPending(root) {
      const descendants = new Set(root.querySelectorAll('*'));
      descendants.add(root);
      for (const anims of this.activeAnimations.values()) {
        anims.forEach(a => {
          if (a.playState === 'finished') return;
          const target = a.effect && a.effect.target;
          if (descendants.has(target)) {
            try { a.cancel(); } catch {}
          }
        });
      }
    }

    // ── P.S. signature helpers ──

    /**
     * Stamp CSS custom properties on the .ps-sig element driving its
     * @keyframe timings. This lets the CSS stay declarative while the JS
     * config owns the numbers.
     */
    _setupPsSignature(ps) {
      const { charOffsets, caretOffsets, caretKillAt } = this.config.ps;
      charOffsets.forEach((t, i)  => ps.style.setProperty(`--ps-c${i+1}`,  t + 's'));
      caretOffsets.forEach((t, i) => ps.style.setProperty(`--ps-k${i+1}`,  t + 's'));
      ps.style.setProperty('--ps-caret-kill', caretKillAt + 's');
    }

    /** Schedule the dots' fade-out at `atSec`. */
    _finishPsSignature(ps, atSec) {
      ps.style.setProperty('--ps-dot-fade', atSec + 's');
      // Make the CSS animation re-read the new variable. We do this by
      // adding a class that applies the final dot-fade animation.
      ps.classList.add('tw-ps-finishing');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Module export
  // ─────────────────────────────────────────────────────────────────────────

  Typewriter.DEFAULTS = DEFAULTS;
  /** Convenience: `Typewriter.mount(opts)` → new instance, started. */
  Typewriter.mount = (opts) => {
    const tw = new Typewriter(opts);
    tw.start();
    return tw;
  };

  window.Typewriter = Typewriter;
})();
