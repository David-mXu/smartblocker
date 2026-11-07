// Self-contained in-page sanitizer injected via chrome.scripting.executeScript.
// Must NOT reference any outer-scope imports or variables so it serializes cleanly.
//
// Responsibilities:
// 1. Universal Embedded Media & Chatbot Video Guard (all hosts, including
//    whitelisted workspaces like Google AI Studio, Gemini, ChatGPT, Claude,
//    Notion, and Google Docs): detects embedded video/social/game iframes
//    (e.g. <ms-youtube-chunk>, iframe[src*="youtube.com/embed/"]), immediately
//    applies a 0-frame pre-classification curtain + pause command, asks the
//    service worker to classify the resolved video metadata (via YouTube oEmbed
//    + bge-small), and masks/unloads distracting embeds while unmasking
//    productive lectures.
// 2. Two-Pass SERP Distraction Masking (Google, Bing, DuckDuckGo, Brave, Yahoo,
//    Baidu, Yandex, Naver, Ecosia): masks unpredictable injected SERP modules
//    (Videos, Short videos, Top stories/News, Sponsored/Popular products,
//    What people are saying/Discussions and forums, Movies/Cast/Watch panels,
//    Games from Google), distracting organic result cards, the entity hero /
//    knowledge panel ("MrBeast · American YouTuber"), and — as a DOM-agnostic
//    backstop — any leftover link to a known distraction host, without
//    blocking the user's entire search tab.

export interface SanitizePageOptions {
  blockedLabels: string[];
  blocklist: string[];
  settingsLocked: boolean;
  maskSearchElements?: boolean;
}

export interface SubItemEvalRequest {
  id: string;
  url: string;
  title?: string;
  channel?: string;
  context?: string;
  kind: 'embed' | 'serp-card';
}

export interface SubItemEvalResult {
  id: string;
  blocked: boolean;
  label: string;
  score: number;
  resolvedTitle?: string;
}

export function sanitizePage(opts: SanitizePageOptions): {
  maskedShelves: number;
  maskedCards: number;
  maskedEmbeds: number;
  pendingItems: number;
} {
  const win = window as unknown as {
    __sbSanitizeOpts?: SanitizePageOptions;
    __sbSanitizeObserver?: MutationObserver;
    __sbSanitizeTimer?: number;
    __sbNextId?: number;
    __sbOrigMedia?: WeakMap<HTMLIFrameElement, { src?: string; srcdoc?: string }>;
  };
  win.__sbSanitizeOpts = opts;
  if (!win.__sbNextId) win.__sbNextId = 1;
  // Original iframe src/srcdoc of masked embeds, kept in isolated-world JS
  // memory (on a window global so re-injection of this script reuses it)
  // instead of page-readable/writable data-sb-orig-* attributes (#16).
  if (!win.__sbOrigMedia) win.__sbOrigMedia = new WeakMap();
  const origMedia = win.__sbOrigMedia;

  const MASK_CSS = `
      [data-smartblocker-masked] > *:not(.smartblocker-mask-bar),
      :host([data-smartblocker-masked]) > *:not(.smartblocker-mask-bar) {
        display: none !important;
      }
      [data-smartblocker-masked="revealed"] > *:not(.smartblocker-mask-bar),
      :host([data-smartblocker-masked="revealed"]) > *:not(.smartblocker-mask-bar) {
        display: revert !important;
      }
      [data-smartblocker-masked="revealed"] > .smartblocker-mask-bar,
      :host([data-smartblocker-masked="revealed"]) > .smartblocker-mask-bar {
        display: none !important;
      }
      [data-smartblocker-state="pending"] iframe,
      [data-smartblocker-state="pending"] video,
      :host([data-smartblocker-state="pending"]) iframe,
      :host([data-smartblocker-state="pending"]) video,
      [data-smartblocker-facade][data-smartblocker-state="pending"] {
        visibility: hidden !important;
        pointer-events: none !important;
      }
      .smartblocker-mask-bar {
        display: flex !important;
        align-items: center !important;
        justify-content: space-between !important;
        gap: 10px !important;
        padding: 7px 12px !important;
        margin: 6px 0 !important;
        border-radius: 8px !important;
        background: rgba(15, 23, 42, 0.06) !important;
        border: 1px solid rgba(100, 116, 139, 0.22) !important;
        color: #64748b !important;
        font: 500 12px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif !important;
        letter-spacing: 0.01em !important;
        user-select: none !important;
      }
      @media (prefers-color-scheme: dark) {
        .smartblocker-mask-bar {
          background: rgba(30, 41, 59, 0.55) !important;
          border-color: rgba(148, 163, 184, 0.2) !important;
          color: #94a3b8 !important;
        }
      }
      .smartblocker-mask-bar-label {
        display: inline-flex !important;
        align-items: center !important;
        gap: 6px !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
      }
      .smartblocker-mask-dot {
        width: 6px !important;
        height: 6px !important;
        border-radius: 50% !important;
        background: #64748b !important;
        flex-shrink: 0 !important;
      }
      .smartblocker-mask-reveal {
        all: unset !important;
        cursor: pointer !important;
        padding: 2px 8px !important;
        border-radius: 5px !important;
        font: 500 11px/1.3 system-ui, -apple-system, sans-serif !important;
        color: #64748b !important;
        border: 1px solid rgba(100, 116, 139, 0.3) !important;
        flex-shrink: 0 !important;
      }
      .smartblocker-mask-reveal:hover {
        background: rgba(100, 116, 139, 0.12) !important;
      }
    `;

  type DeepRoot = Document | ShadowRoot | Element;

  function ensureMaskCss(root: Node | null | undefined): void {
    const r = (root ?? document) as Document | ShadowRoot;
    if (typeof r.querySelector !== 'function') return;
    const existing = r.querySelector('#smartblocker-mask-style');
    if (existing) {
      // A hostile page may empty the style node instead of removing it.
      if (existing.textContent !== MASK_CSS) existing.textContent = MASK_CSS;
      return;
    }
    const style = document.createElement('style');
    style.id = 'smartblocker-mask-style';
    style.textContent = MASK_CSS;
    if (r === document) {
      (document.head || document.documentElement)?.appendChild(style);
    } else {
      r.appendChild(style);
    }
  }

  ensureMaskCss(document);

  function collectOpenRoots(start: DeepRoot = document): DeepRoot[] {
    const roots: DeepRoot[] = [start];
    const seen = new Set<DeepRoot>(roots);
    if (start instanceof Element && start.shadowRoot) {
      seen.add(start.shadowRoot);
      roots.push(start.shadowRoot);
    }
    for (let i = 0; i < roots.length; i++) {
      const all = roots[i].querySelectorAll('*');
      for (let j = 0; j < all.length; j++) {
        const sr = (all[j] as Element).shadowRoot;
        if (sr && !seen.has(sr)) {
          seen.add(sr);
          roots.push(sr);
        }
      }
    }
    return roots;
  }

  function queryAllDeep(selector: string, roots: DeepRoot[] = collectOpenRoots()): Element[] {
    const out: Element[] = [];
    for (let i = 0; i < roots.length; i++) {
      const root = roots[i];
      if (root instanceof Element && root.matches(selector)) out.push(root);
      const found = root.querySelectorAll(selector);
      for (let j = 0; j < found.length; j++) out.push(found[j]);
    }
    return out;
  }

  function findBySmartBlockerId(id: string): Element | null {
    const sel = `[data-smartblocker-id="${id}"]`;
    const direct = document.querySelector(sel);
    if (direct) return direct;
    const roots = collectOpenRoots(document);
    for (let i = 0; i < roots.length; i++) {
      const found = roots[i].querySelector(sel);
      if (found) return found;
    }
    return null;
  }

  function iframeSource(f: HTMLIFrameElement): string {
    return (
      f.getAttribute('src') ||
      f.getAttribute('data-src') ||
      f.getAttribute('data-lazy-src') ||
      f.getAttribute('data-original') ||
      ''
    );
  }

  function textOf(el: Element | null | undefined): string {
    return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  function normHost(rawUrl: string): string {
    try {
      return new URL(rawUrl, location.href).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  function nextId(prefix: string): string {
    const id = `${prefix}-${win.__sbNextId ?? 1}`;
    win.__sbNextId = (win.__sbNextId ?? 1) + 1;
    return id;
  }

  function pauseAndUnloadMedia(root: Element): void {
    const roots = collectOpenRoots(root);
    const mediaEls = queryAllDeep('video, audio', roots);
    for (let i = 0; i < mediaEls.length; i++) {
      try {
        (mediaEls[i] as HTMLMediaElement).pause();
        (mediaEls[i] as HTMLMediaElement).muted = true;
      } catch {
        // ignore
      }
    }
    const iframes = queryAllDeep('iframe', roots);
    for (let i = 0; i < iframes.length; i++) {
      const f = iframes[i] as HTMLIFrameElement;
      try {
        f.contentWindow?.postMessage('{"event":"command","func":"pauseVideo","args":""}', '*');
        const src = iframeSource(f);
        const srcdoc = f.getAttribute('srcdoc');
        if (srcdoc !== null) {
          // Stash in isolated-world memory, keep-first: the origin seen at the
          // first mask is what a later trusted "Show" restores — a hostile
          // re-point must not become the restore target.
          const rec = origMedia.get(f) ?? {};
          if (rec.srcdoc === undefined) rec.srcdoc = srcdoc;
          origMedia.set(f, rec);
          f.removeAttribute('srcdoc');
        }
        if (src && src !== 'about:blank') {
          const rec = origMedia.get(f) ?? {};
          if (rec.src === undefined) rec.src = src;
          origMedia.set(f, rec);
          f.src = 'about:blank';
        }
      } catch {
        // ignore
      }
    }
  }

  function maskElement(
    el: Element,
    kind: 'serp-shelf' | 'serp-card' | 'embed',
    reason: string,
    unloadIframes = true,
    followers: Element[] = [],
  ): boolean {
    const currentState = el.getAttribute('data-smartblocker-masked');
    if (currentState === 'revealed' || currentState === kind) return false;
    // Followers: sibling pieces of ONE logical module (e.g. Google's entity
    // hero, split across several #rcnt rows) hidden together under a single
    // bar instead of one bar per row. No bar of their own — the leader's
    // "Show" reveals them all.
    for (let i = 0; i < followers.length; i++) {
      const f = followers[i];
      if (f === el || f.getAttribute('data-smartblocker-masked') === 'revealed') continue;
      ensureMaskCss(f.getRootNode());
      f.setAttribute('data-smartblocker-masked', kind);
      f.setAttribute('data-smartblocker-reason', reason);
      if (unloadIframes) pauseAndUnloadMedia(f);
    }
    ensureMaskCss(el.getRootNode());
    if (el.shadowRoot) ensureMaskCss(el.shadowRoot);
    el.setAttribute('data-smartblocker-masked', kind);
    el.setAttribute('data-smartblocker-reason', reason);
    el.removeAttribute('data-smartblocker-state');

    if (unloadIframes) pauseAndUnloadMedia(el);

    const existingBar = el.querySelector(':scope > .smartblocker-mask-bar');
    if (existingBar) existingBar.remove();

    const activeOpts = win.__sbSanitizeOpts ?? opts;
    const bar = document.createElement('div');
    bar.className = 'smartblocker-mask-bar';

    const labelSpan = document.createElement('span');
    labelSpan.className = 'smartblocker-mask-bar-label';
    const dot = document.createElement('span');
    dot.className = 'smartblocker-mask-dot';
    const textNode = document.createTextNode(`SmartBlocker masked: ${reason}`);
    labelSpan.appendChild(dot);
    labelSpan.appendChild(textNode);
    bar.appendChild(labelSpan);

    if (!activeOpts.settingsLocked) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'smartblocker-mask-reveal';
      btn.textContent = 'Show';
      btn.addEventListener('click', (ev) => {
        // Synthetic clicks from the masked PAGE must not reveal distractions.
        if (!ev.isTrusted) return;
        ev.preventDefault();
        ev.stopPropagation();
        el.setAttribute('data-smartblocker-masked', 'revealed');
        for (let i = 0; i < followers.length; i++) {
          followers[i].setAttribute('data-smartblocker-masked', 'revealed');
        }
        const subRoots: DeepRoot[] = [];
        const revealRoots = [el, ...followers];
        for (let i = 0; i < revealRoots.length; i++) {
          subRoots.push(...collectOpenRoots(revealRoots[i]));
        }
        const iframes = queryAllDeep('iframe', subRoots);
        for (let i = 0; i < iframes.length; i++) {
          const f = iframes[i] as HTMLIFrameElement;
          const rec = origMedia.get(f);
          if (!rec) continue;
          if (rec.srcdoc !== undefined) f.setAttribute('srcdoc', rec.srcdoc);
          if (rec.src !== undefined) f.src = rec.src;
        }
      });
      bar.appendChild(btn);
    }

    el.insertBefore(bar, el.firstChild);
    return true;
  }

  function extractYouTubeId(rawUrl: string): string | null {
    try {
      const u = new URL(rawUrl, location.href);
      const h = u.hostname.toLowerCase().replace(/^(?:www|m|music)\./, '');
      if (h === 'youtu.be') {
        const id = u.pathname.split('/').filter(Boolean)[0];
        return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
      }
      if (h === 'youtube.com' || h === 'youtube-nocookie.com') {
        const v = u.searchParams.get('v') || u.searchParams.get('video');
        if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
        const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/);
        if (m) return m[1];
      }
    } catch {
      // ignore
    }
    return null;
  }

  function facadeVideoId(el: Element): string | null {
    const direct =
      el.getAttribute('videoid') ||
      el.getAttribute('video-id') ||
      el.getAttribute('data-videoid') ||
      el.getAttribute('data-video-id') ||
      '';
    if (/^[A-Za-z0-9_-]{11}$/.test(direct)) return direct;
    const hay = `${el.getAttribute('style') || ''} ${el.innerHTML || ''}`;
    const m = hay.match(/(?:\/vi\/|embed\/|watch\?v=)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
  }

  function resolveResultHref(raw: string): string {
    if (!raw) return '';
    try {
      const u = new URL(raw, location.href);
      const host = u.hostname.toLowerCase().replace(/^www\./, '');
      if (
        /(?:^|\.)google\.[a-z]{2,3}(?:\.[a-z]{2})?$/.test(host) &&
        /^\/(?:url|imgres)$/.test(u.pathname)
      ) {
        const q =
          u.searchParams.get('q') || u.searchParams.get('url') || u.searchParams.get('imgurl');
        if (q) return q;
      }
      return u.href;
    } catch {
      return '';
    }
  }

  function headingLabel(el: Element): string {
    const clone = el.cloneNode(true) as Element;
    const junk = clone.querySelectorAll('a, button, svg, [role="button"]');
    for (let i = 0; i < junk.length; i++) junk[i].remove();
    return (clone.textContent || '')
      .replace(/\s+/g, ' ')
      .replace(/\s*[·•|—–]\s*.*$/, '')
      .trim();
  }

  function matchesBlocklist(url: string, title: string, list: string[]): string | null {
    const hay = `${url} ${title}`.toLowerCase();
    for (let i = 0; i < list.length; i++) {
      const needle = (list[i] ?? '').trim().toLowerCase();
      if (needle && hay.includes(needle)) return list[i].trim();
    }
    return null;
  }

  function runScan(): {
    maskedShelves: number;
    maskedCards: number;
    maskedEmbeds: number;
    pendingItems: number;
  } {
    const activeOpts = win.__sbSanitizeOpts ?? opts;
    const blockedSet = new Set(activeOpts.blockedLabels);
    const hostLower = location.hostname.toLowerCase().replace(/^www\./, '');
    const deepRoots = collectOpenRoots(document);

    // Re-ensure the mask stylesheet every scan: a hostile page can delete or
    // empty the injected <style> mid-session to unmask everything (#16). The
    // per-root check is cheap and idempotent.
    for (let i = 0; i < deepRoots.length; i++) {
      ensureMaskCss(deepRoots[i]);
    }

    let maskedShelves = 0;
    let maskedCards = 0;
    let maskedEmbeds = 0;
    const pendingEval: SubItemEvalRequest[] = [];

    // ── PART A: Universal Embedded Media & Chatbot Video/Social Guard ────────
    // Runs on all pages except top-level youtube.com (which is classified as a
    // whole page), catching embedded YouTube/TikTok/Twitch/Instagram/X players
    // inside Google AI Studio, Gemini, ChatGPT, Claude, Notion, Docs, and SERPs
    // across both light DOM and open Shadow DOM roots.
    const isTopLevelYouTube =
      hostLower === 'youtube.com' ||
      hostLower.endsWith('.youtube.com') ||
      hostLower === 'youtube-nocookie.com' ||
      hostLower.endsWith('.youtube-nocookie.com') ||
      hostLower === 'youtu.be';

    if (!isTopLevelYouTube) {
      const iframes = queryAllDeep(
        'iframe[src], iframe[data-src], iframe[data-lazy-src], iframe[data-original], iframe[srcdoc]',
        deepRoots,
      );
      for (let i = 0; i < iframes.length; i++) {
        const f = iframes[i] as HTMLIFrameElement;
        const src = iframeSource(f);
        const srcdoc = f.getAttribute('srcdoc') || '';
        if ((!src || src === 'about:blank') && !srcdoc) continue;

        const rootNode = f.getRootNode();
        const shadowHost =
          rootNode instanceof ShadowRoot && rootNode.host ? rootNode.host : null;
        const container =
          f.closest('ms-youtube-chunk') ||
          f.closest('youtube-video') ||
          f.closest('.youtube-container-wrapper') ||
          f.closest('.video-container') ||
          (shadowHost &&
          /^(?:ms-youtube-chunk|youtube-video|lite-youtube|yt-lite)$/i.test(shadowHost.tagName)
            ? shadowHost
            : null) ||
          f.parentElement ||
          shadowHost ||
          f;
        const maskedState = container.getAttribute('data-smartblocker-masked');
        if (maskedState || container.getAttribute('data-smartblocker-state')) {
          // Self-heal: the attribute observer re-triggers a scan when a hostile
          // page points a blanked iframe back at real media — re-unload it
          // unless the user explicitly revealed this container.
          if (maskedState && maskedState !== 'revealed') pauseAndUnloadMedia(container);
          continue;
        }

        const effectiveRef = src || srcdoc;
        const embedHost = src ? normHost(src) : '';
        const blHit = matchesBlocklist(effectiveRef, f.title || '', activeOpts.blocklist);
        if (blHit) {
          if (maskElement(container, 'embed', `blocked rule "${blHit}"`)) maskedEmbeds++;
          continue;
        }

        // 1. Unconditionally distracting social/streaming/game embeds
        const isSocialOrStreamEmbed =
          /(?:^|\.)(?:player\.twitch\.tv|clips\.twitch\.tv|twitch\.tv|kick\.com|tiktok\.com|instagram\.com|platform\.twitter\.com|twitter\.com|x\.com|redditmedia\.com|v\.redd\.it)$/i.test(
            embedHost,
          ) || /\/shorts\//i.test(effectiveRef);
        const isGameEmbed =
          /(?:^|\.)(?:poki\.com|crazygames\.com|itch\.io|html\.itch\.io|construct\.net|stage\.construct\.net|cardgames\.io|minesweeper\.online)$/i.test(
            embedHost,
          );

        if (isGameEmbed && blockedSet.has('video games')) {
          if (maskElement(container, 'embed', `Embedded game (${embedHost})`)) maskedEmbeds++;
          continue;
        }

        if (
          isSocialOrStreamEmbed &&
          (blockedSet.has('memes and entertainment') ||
            blockedSet.has('social media and networking') ||
            blockedSet.has('video games'))
        ) {
          if (maskElement(container, 'embed', `Embedded media (${embedHost || 'video'})`)) {
            maskedEmbeds++;
          }
          continue;
        }

        // 2. YouTube / Vimeo / Bilibili embeds: pre-curtain at 0ms so zero frames
        // play, then classify via background service worker (YouTube oEmbed + bge-small).
        const ytId =
          extractYouTubeId(effectiveRef) ||
          (effectiveRef.match(/(?:youtube(?:-nocookie)?\.com\/embed\/|youtu\.be\/)([A-Za-z0-9_-]{11})/)?.[1] ??
            null);
        const isVideoEmbed =
          ytId !== null ||
          /(?:^|\.)(?:youtube\.com|youtube-nocookie\.com|player\.vimeo\.com|player\.bilibili\.com|dailymotion\.com)$/i.test(
            embedHost,
          );

        if (isVideoEmbed) {
          ensureMaskCss(container.getRootNode());
          const itemId = nextId('sb-embed');
          container.setAttribute('data-smartblocker-id', itemId);
          container.setAttribute('data-smartblocker-state', 'pending');
          try {
            f.contentWindow?.postMessage(
              '{"event":"command","func":"pauseVideo","args":""}',
              '*',
            );
          } catch {
            // ignore
          }
          const rawTitle = (f.title || '').trim();
          const usableTitle =
            rawTitle && !/^youtube video player$/i.test(rawTitle) ? rawTitle : undefined;
          pendingEval.push({
            id: itemId,
            url: ytId ? `https://www.youtube.com/watch?v=${ytId}` : src,
            title: usableTitle,
            channel: embedHost || 'youtube.com',
            context: 'Embedded video player.',
            kind: 'embed',
          });
        }
      }

      // 3. Lite-YouTube & custom video facades (before iframe even mounts on click)
      const facades = queryAllDeep(
        'lite-youtube[videoid], yt-lite, [data-videoid], [data-video-id]',
        deepRoots,
      );
      for (let i = 0; i < facades.length; i++) {
        const host = facades[i];
        if (
          host.getAttribute('data-smartblocker-masked') ||
          host.getAttribute('data-smartblocker-state')
        ) {
          continue;
        }
        const ytId = facadeVideoId(host);
        if (!ytId) continue;
        const blHit = matchesBlocklist(
          `https://www.youtube.com/watch?v=${ytId}`,
          host.getAttribute('title') || '',
          activeOpts.blocklist,
        );
        if (blHit) {
          if (maskElement(host, 'embed', `blocked rule "${blHit}"`)) maskedEmbeds++;
          continue;
        }
        ensureMaskCss(host.getRootNode());
        const itemId = nextId('sb-facade');
        host.setAttribute('data-smartblocker-id', itemId);
        host.setAttribute('data-smartblocker-state', 'pending');
        host.setAttribute('data-smartblocker-facade', '1');
        pendingEval.push({
          id: itemId,
          url: `https://www.youtube.com/watch?v=${ytId}`,
          title: host.getAttribute('title') || host.getAttribute('playlabel') || undefined,
          channel: 'youtube.com',
          context: 'Embedded video facade.',
          kind: 'embed',
        });
      }

      // Also scan AI chatbot conversations (AI Studio, Gemini, ChatGPT, Claude,
      // Perplexity, Poe, Copilot) for pasted/rendered YouTube watch/shorts cards
      const isChatbotHost =
        /(?:^|\.)(?:aistudio\.google\.com|gemini\.google\.com|chatgpt\.com|claude\.ai|perplexity\.ai|poe\.com|copilot\.microsoft\.com)$/i.test(
          hostLower,
        );
      if (isChatbotHost) {
        const ytLinks = queryAllDeep(
          'a[href*="youtube.com/watch"], a[href*="youtube.com/shorts"], a[href*="youtu.be/"], a[href*="tiktok.com/"], a[href*="twitch.tv/"]',
          deepRoots,
        );
        for (let i = 0; i < ytLinks.length; i++) {
          const a = ytLinks[i] as HTMLAnchorElement;
          const card =
            a.closest('ms-youtube-chunk, youtube-video, .youtube-container-wrapper') || a;
          if (
            card.getAttribute('data-smartblocker-masked') ||
            card.getAttribute('data-smartblocker-state')
          ) {
            continue;
          }
          const href = a.href || '';
          const linkHost = normHost(href);
          if (
            /tiktok\.com|twitch\.tv|\/shorts\//i.test(href) &&
            (blockedSet.has('memes and entertainment') ||
              blockedSet.has('social media and networking'))
          ) {
            if (maskElement(card, 'embed', `Distracting media link (${linkHost})`)) maskedEmbeds++;
            continue;
          }
          const ytId = extractYouTubeId(href);
          if (ytId) {
            ensureMaskCss(card.getRootNode());
            const itemId = nextId('sb-chatlink');
            card.setAttribute('data-smartblocker-id', itemId);
            card.setAttribute('data-smartblocker-state', 'pending');
            const linkText = textOf(a);
            pendingEval.push({
              id: itemId,
              url: `https://www.youtube.com/watch?v=${ytId}`,
              title:
                linkText && !/^https?:\/\//i.test(linkText) && linkText.length > 3
                  ? linkText
                  : undefined,
              channel: 'youtube.com',
              context: 'Video link in chat.',
              kind: 'embed',
            });
          }
        }
      }
    }

    // ── PART B: Two-Pass SERP Distraction Masking ────────────────────────────
    const isSerpHost =
      /^(?:(?:www|cn|m|html|lite|search|images|video|videos|shopping)\.)?(?:google\.[a-z]{2,3}(?:\.[a-z]{2})?|bing\.com|duckduckgo\.com|brave\.com|yahoo\.[a-z]{2,3}(?:\.[a-z]{2})?|baidu\.com|yandex\.[a-z]{2,3}|naver\.com|ecosia\.org)$/i.test(
        location.hostname.toLowerCase(),
      );

    if (isSerpHost) {
      if (activeOpts.maskSearchElements === false) {
        // Search element masking disabled by setting: reveal any previously masked SERP elements
        const maskedSerpEls = document.querySelectorAll(
          '[data-smartblocker-masked="serp-shelf"], [data-smartblocker-masked="serp-card"]',
        );
        for (let i = 0; i < maskedSerpEls.length; i++) {
          const el = maskedSerpEls[i];
          el.setAttribute('data-smartblocker-masked', 'revealed');
          el.querySelector(':scope > .smartblocker-mask-bar')?.remove();
        }
      } else {
        const isVideoVertical =
        /[?&](?:tbm=vid|udm=(?:7|vids))\b/i.test(location.search) ||
        /^\/(?:videos?|videohub)\b/i.test(location.pathname) ||
        /\/videos\/search\b/i.test(location.pathname) ||
        /[?&]ia=videos?\b/i.test(location.search);

      // 1. Direct ad / PLA / shopping containers
      if (blockedSet.has('online shopping')) {
        const adContainers = document.querySelectorAll(
          '#tads, #tvcap, #bottomads, .pla-unit, .mnr-c.pla-unit, .sh-dgr__content, .commercial-unit-desktop-top, .commercial-unit-desktop-rhs, #b_results > li.b_ad, [data-testid="ad"], .result--ad',
        );
        for (let i = 0; i < adContainers.length; i++) {
          const el = adContainers[i];
          if (el && textOf(el).length > 0) {
            if (maskElement(el, 'serp-shelf', 'Sponsored / Shopping module')) maskedShelves++;
          }
        }
      }

      // 1b. Inline SERP video preview drawers / modal players (e.g. Google Videos preview dialog)
      const previewMedia = queryAllDeep(
        '[role="dialog"] video, [role="dialog"] iframe, g-lightbox video, g-lightbox iframe, .video-preview video, .video-preview iframe',
        deepRoots,
      );
      for (let i = 0; i < previewMedia.length; i++) {
        const media = previewMedia[i];
        const box =
          media.closest('[role="dialog"], g-lightbox, .video-preview') ||
          media.parentElement ||
          media;
        if (box.closest('[data-smartblocker-masked], [data-smartblocker-state="pending"]')) {
          continue;
        }
        if (
          blockedSet.has('memes and entertainment') ||
          blockedSet.has('social media and networking') ||
          blockedSet.has('video games')
        ) {
          if (maskElement(box, 'embed', 'Inline SERP video preview')) maskedEmbeds++;
        }
      }

      // 2. SERP Shelves / Carousels identified by section heading or structural evidence
      const VIDEO_HEADING_RE =
        /^(?:videos?|short videos?|shorts?|reels?|featured videos?|trending videos?|popular videos?|top videos?|latest videos?|related videos?|more videos?|video results?|video highlights?|watch videos?|vídeos?|vidéos?|동영상|動画|视频)(?:\s+(?:for|from|about|by|on)\b.*)?$/i;
      const NEWS_HEADING_RE =
        /^(?:top stories|in the news|latest news|breaking news|news|local news|actualités|noticias|nachrichten|ニュース|뉴스|最新消息)$/i;
      const SHOPPING_HEADING_RE =
        /^(?:sponsored products?|sponsored results?|sponsored|popular products|shop on google|find related products(?: & services)?|buying guide|deals on .+|top products)$/i;
      const SOCIAL_HEADING_RE =
        /^(?:what people are saying|latest posts from .+|discussions and forums|perspectives|posts on x|from social media|trending posts)$/i;
      const MOVIES_HEADING_RE =
        /^(?:movies|tv shows|watch movie|where to watch|cast|episodes|trailers|popular movies)$/i;
      const GAMES_HEADING_RE =
        /^(?:games from google|play minesweeper|play pac-man|play snake|play solitaire|tic-tac-toe)$/i;
      const RELATED_BAIT_RE = /^(?:people also search for|related searches)$/i;

      const shelfCandidates = document.querySelectorAll(
        '#rso > div, #rso div.ULSxyf, #rso div.MjjYud, #botstuff div.MjjYud, #rhs > div, #b_results > li.b_ans, #b_results > li.b_vidAns, [data-testid="videos"], [data-testid="news"]',
      );

      for (let i = 0; i < shelfCandidates.length; i++) {
        const mod = shelfCandidates[i];
        if (
          mod.getAttribute('data-smartblocker-masked') ||
          mod.closest('[data-smartblocker-masked]')
        ) {
          continue;
        }
        // Never mask a wrapper that contains multiple separate top-level MjjYud organic results
        // unless the wrapper itself is an ULSxyf shelf or starts with a module heading.
        const childOrganicCards = mod.querySelectorAll(':scope > div div.MjjYud h3');
        const isShelfBox =
          mod.classList.contains('ULSxyf') ||
          mod.classList.contains('b_vidAns') ||
          mod.classList.contains('b_ans') ||
          childOrganicCards.length <= 1;
        if (!isShelfBox) continue;

        // Check module headings (headings NOT inside a result card link)
        const headings = mod.querySelectorAll('h2, h3, [role="heading"]');
        let shelfReason: string | null = null;

        for (let hIdx = 0; hIdx < headings.length; hIdx++) {
          const hEl = headings[hIdx];
          if (hEl.closest('a[href]')) continue;
          const hText = headingLabel(hEl) || textOf(hEl);
          if (!hText) continue;

          if (GAMES_HEADING_RE.test(hText) && blockedSet.has('video games')) {
            shelfReason = `Playable games shelf (${hText})`;
            break;
          }
          if (
            VIDEO_HEADING_RE.test(hText) &&
            (blockedSet.has('memes and entertainment') ||
              blockedSet.has('social media and networking') ||
              blockedSet.has('video games'))
          ) {
            shelfReason = `Embedded ${hText} carousel`;
            break;
          }
          if (NEWS_HEADING_RE.test(hText)) {
            shelfReason = `Embedded ${hText} news shelf`;
            break;
          }
          if (SHOPPING_HEADING_RE.test(hText) && blockedSet.has('online shopping')) {
            shelfReason = `Shopping module (${hText})`;
            break;
          }
          if (
            SOCIAL_HEADING_RE.test(hText) &&
            (blockedSet.has('social media and networking') ||
              blockedSet.has('memes and entertainment'))
          ) {
            shelfReason = `Social feed (${hText})`;
            break;
          }
          if (MOVIES_HEADING_RE.test(hText)) {
            shelfReason = `Entertainment module (${hText})`;
            break;
          }
          if (RELATED_BAIT_RE.test(hText)) {
            shelfReason = `Search rabbit-hole suggestions (${hText})`;
            break;
          }
        }

        // Structural evidence fallback when Google omits/obfuscates the heading
        if (!shelfReason) {
          if (
            mod.querySelector('canvas, a[href*="/fbx?fbx="], [data-ly*="game"]') &&
            blockedSet.has('video games')
          ) {
            shelfReason = 'Playable browser game widget';
          } else if (
            mod.querySelector('[data-merchant-id], .sh-dgr__content, .pla-unit') &&
            blockedSet.has('online shopping')
          ) {
            shelfReason = 'Shopping product carousel';
          } else if (mod.classList.contains('ULSxyf') || mod.classList.contains('b_vidAns')) {
            const vidLinks = mod.querySelectorAll(
              'a[href*="youtube.com/watch"], a[href*="youtube.com/shorts"], a[href*="tiktok.com"], a[href*="instagram.com/reel"], a[href*="twitch.tv"]',
            );
            if (
              vidLinks.length >= 2 &&
              (blockedSet.has('memes and entertainment') ||
                blockedSet.has('social media and networking'))
            ) {
              shelfReason = 'Embedded Videos carousel';
            }
          }
        }

        if (shelfReason) {
          if (maskElement(mod, 'serp-shelf', shelfReason)) maskedShelves++;
        }
      }

      // 3. Leaf Organic Search Result Cards (Pass 1 deterministic + Pass 2 ML)
      const VIDEO_SOCIAL_HOST_RE =
        /(?:^|\.)(?:youtube\.com|youtu\.be|tiktok\.com|instagram\.com|x\.com|twitter\.com|threads\.net|facebook\.com|twitch\.tv|kick\.com|9gag\.com|buzzfeed\.com|tmz\.com|knowyourmeme\.com|boredpanda\.com)$/i;
      const SHOPPING_HOST_RE =
        /(?:^|\.)(?:amazon\.[a-z.]+|bestbuy\.[a-z.]+|newegg\.[a-z.]+|walmart\.[a-z.]+|ebay\.[a-z.]+|etsy\.com|target\.com|aliexpress\.[a-z.]+|temu\.com|shein\.com|wayfair\.com|macys\.com|nordstrom\.com|zara\.com|sephora\.com|bhphotovideo\.com|microcenter\.com|memoryexpress\.com|[a-z0-9-]+\.store)$/i;
      const GAMING_HOST_RE =
        /(?:^|\.)(?:store\.steampowered\.com|steamcommunity\.com|epicgames\.com|gog\.com|itch\.io|ign\.com|kotaku\.com|pcgamer\.com|gamespot\.com|polygon\.com|eurogamer\.net|poki\.com|crazygames\.com|minesweeper\.online|minesweeperonline\.com|cardgames\.io|1000mines\.com|freeminesweeper\.org|minesweeper\.one|play\.google\.com)$/i;
      const STREAMING_MOVIE_HOST_RE =
        /(?:^|\.)(?:netflix\.com|disneyplus\.com|hulu\.com|max\.com|primevideo\.com|tv\.apple\.com|paramountmovies\.com|peacocktv\.com|crunchyroll\.com|rottentomatoes\.com|imdb\.com|letterboxd\.com|[a-z0-9-]+\.fandom\.com)$/i;
      const GAMBLING_HOST_RE =
        /(?:^|\.)(?:draftkings\.com|fanduel\.com|betmgm\.com|bet365\.com|stake\.com|polymarket\.com|kalshi\.com|oddsshark\.com|actionnetwork\.com|vegasinsider\.com)$/i;
      const NEWS_ARTICLE_HOST_RE =
        /(?:^|\.)(?:nytimes\.com|cnn\.com|foxnews\.com|bbc\.com|bbc\.co\.uk|theguardian\.com|washingtonpost\.com|wsj\.com|reuters\.com|apnews\.com|nbcnews\.com|cbsnews\.com|abcnews\.go\.com|usatoday\.com|nypost\.com|dailymail\.co\.uk|theglobeandmail\.com|cbc\.ca|ctvnews\.ca|globalnews\.ca|forbes\.com|businessinsider\.com|cnbc\.com|politico\.com|thehill\.com|axios\.com|huffpost\.com|people\.com|variety\.com|hollywoodreporter\.com|deadline\.com|driveteslacanada\.ca)$/i;

      const cardEls = document.querySelectorAll(
        '#rso div.MjjYud, #b_results > li.b_algo, article[data-testid="result"]',
      );
      const pendingBudget = isVideoVertical ? 20 : 15;

      for (let i = 0; i < cardEls.length; i++) {
        const card = cardEls[i];
        if (
          card.getAttribute('data-smartblocker-masked') ||
          card.getAttribute('data-smartblocker-state') ||
          card.closest('[data-smartblocker-masked]')
        ) {
          continue;
        }
        // Skip wrapper MjjYud divs that contain inner MjjYud result cards
        if (card.querySelector(':scope div.MjjYud h3')) continue;

        const titleEl = card.querySelector('h3, h2, [role="heading"]');
        const cardTitle = textOf(titleEl);
        if (!cardTitle) continue;

        // Find primary external link (unwrapping /url?q=... Google redirect links)
        const links = card.querySelectorAll('a[href]');
        let cardUrl = '';
        let cardHost = '';
        for (let lIdx = 0; lIdx < links.length; lIdx++) {
          const rawHref = (links[lIdx] as HTMLAnchorElement).getAttribute('href') || '';
          const href = resolveResultHref(rawHref);
          const h = normHost(href);
          if (
            h &&
            !/^(?:google\.[a-z.]+|bing\.com|duckduckgo\.com|support\.google\.com|policies\.google\.com|translate\.google\.com|accounts\.google\.com)$/i.test(
              h,
            )
          ) {
            cardUrl = href;
            cardHost = h;
            break;
          }
        }
        if (!cardUrl || !cardHost) continue;

        const snippetEl = card.querySelector(
          '.VwiC3b, [data-sncf], .b_caption p, [data-testid="result-snippet"]',
        );
        const cardSnippet = textOf(snippetEl) || textOf(card).slice(0, 260);

        // Pass 1A: User blocklist match
        const blHit = matchesBlocklist(cardUrl, cardTitle, activeOpts.blocklist);
        if (blHit) {
          if (maskElement(card, 'serp-card', `blocked rule "${blHit}" (${cardHost})`)) {
            maskedCards++;
          }
          continue;
        }

        // Pass 1B: Known distraction domain / URL patterns
        let cardReason: string | null = null;
        if (GAMBLING_HOST_RE.test(cardHost) && blockedSet.has('gambling and betting')) {
          cardReason = `gambling and betting result (${cardHost})`;
        } else if (GAMING_HOST_RE.test(cardHost) && blockedSet.has('video games')) {
          cardReason = `video games result (${cardHost})`;
        } else if (
          (SHOPPING_HOST_RE.test(cardHost) ||
            /\/(?:shop\/buy-|cart|checkout|dp\/|gp\/product\/)/i.test(cardUrl) ||
            /\bup to \d+% cash back\b/i.test(textOf(card))) &&
          blockedSet.has('online shopping')
        ) {
          cardReason = `online shopping result (${cardHost})`;
        } else if (
          VIDEO_SOCIAL_HOST_RE.test(cardHost) &&
          (blockedSet.has('memes and entertainment') ||
            blockedSet.has('social media and networking'))
        ) {
          cardReason = `video / social result (${cardHost})`;
        } else if (STREAMING_MOVIE_HOST_RE.test(cardHost)) {
          cardReason = `streaming / entertainment result (${cardHost})`;
        } else if (NEWS_ARTICLE_HOST_RE.test(cardHost)) {
          cardReason = `news article result (${cardHost})`;
        }

        if (cardReason) {
          if (maskElement(card, 'serp-card', cardReason)) maskedCards++;
          continue;
        }

        // Pass 2: Queue remaining ambiguous organic cards (e.g. reddit.com,
        // medium.com, unknown blogs/stores, or video results when only gaming is blocked)
        if (pendingEval.length < pendingBudget) {
          const itemId = nextId('sb-card');
          card.setAttribute('data-smartblocker-id', itemId);
          card.setAttribute('data-smartblocker-state', 'evaluated');
          pendingEval.push({
            id: itemId,
            url: cardUrl,
            title: cardTitle,
            channel: cardHost,
            context: cardSnippet,
            kind: 'serp-card',
          });
        }
      }

      const memesOrSocial =
        blockedSet.has('memes and entertainment') || blockedSet.has('social media and networking');

      // 4. Entity hero / knowledge panel ("MrBeast · American YouTuber" + image
      // collage + "MrBeast - YouTube" + latest-video tiles). On Google's
      // current desktop layout the hero is a stack of #rcnt rows ABOVE and
      // OUTSIDE #center_col, so every #rso-scoped pass above misses it.
      // Deterministic subtitle match first, ML verdict otherwise; a
      // distracting entity masks all of its hero rows under ONE bar.
      const ENTITY_SOCIAL_RE =
        /\b(?:youtubers?|youtube (?:personality|channel|star|creator)|(?:twitch |live |video game )?streamers?|tiktokers?|tiktok (?:star|personality|creator)|instagram (?:star|influencer|personality)|(?:social media|internet|online|media) (?:personality|celebrity|influencer|star)|influencers?|content creators?|vloggers?|internet memes?)\b/i;
      const ENTITY_GAME_RE =
        /\b(?:video games?|game series|mobile games?|esports?|e-sports|(?:professional|pro) gamers?|battle royale|mmorpg|first-person shooter)\b/i;
      const ENTITY_GAMBLING_RE =
        /\b(?:online casinos?|casinos?|sportsbooks?|online gambling|betting (?:company|site|exchange))\b/i;

      const entityHeroTargets = (titleEl: Element): Element[] => {
        const rcnt = document.getElementById('rcnt');
        const centerCol = document.getElementById('center_col');
        if (rcnt && centerCol && centerCol.parentElement === rcnt) {
          let row: Element | null = titleEl;
          while (row && row.parentElement !== rcnt) row = row.parentElement;
          if (
            row &&
            row !== centerCol &&
            row.id !== 'rhs' &&
            !row.querySelector('#rso, #center_col, #rhs') &&
            // Hero rows sit ABOVE the results column.
            row.compareDocumentPosition(centerCol) & Node.DOCUMENT_POSITION_FOLLOWING
          ) {
            const rows: Element[] = [row];
            const kids = rcnt.children;
            for (let k = 0; k < kids.length; k++) {
              const c = kids[k];
              if (c === centerCol) break; // only rows preceding the results column
              if (c === row || c.tagName !== 'DIV') continue;
              if (c.querySelector('#rso, #center_col, #rhs, [data-attrid="title"]')) continue;
              if (!textOf(c) && !c.querySelector('img, a[href]')) continue;
              rows.push(c);
            }
            return rows;
          }
        }
        // Classic layouts: the entity card is a #rhs block / kp-wholepage box.
        const box = titleEl.closest('#rhs > div, .kp-wholepage, [data-kpid]');
        if (
          !box ||
          box.querySelector('#rso, #center_col') ||
          box.querySelectorAll('div.MjjYud h3').length > 1
        ) {
          return [];
        }
        return [box];
      };

      const entityTitles = document.querySelectorAll('[data-attrid="title"]');
      for (let i = 0; i < entityTitles.length; i++) {
        const titleEl = entityTitles[i];
        const targets = entityHeroTargets(titleEl);
        if (targets.length === 0) continue;
        const leader = targets[0];
        if (targets.some((t) => t.closest('[data-smartblocker-masked]'))) continue;
        if (leader.getAttribute('data-smartblocker-state')) continue; // verdict pending/allowed
        const entTitle = textOf(titleEl);
        if (!entTitle) continue;
        let subtitle = '';
        let description = '';
        for (let t = 0; t < targets.length; t++) {
          if (!subtitle) subtitle = textOf(targets[t].querySelector('[data-attrid="subtitle"]'));
          if (!description) {
            description = textOf(targets[t].querySelector('[data-attrid="description"]'));
          }
        }
        const followers = targets.slice(1);
        const entLabel = subtitle ? `${entTitle} — ${subtitle}` : entTitle;

        let entReason: string | null = null;
        const entBl = matchesBlocklist(location.href, entLabel, activeOpts.blocklist);
        if (entBl) {
          entReason = `blocked rule "${entBl}" (${entTitle})`;
        } else if (ENTITY_SOCIAL_RE.test(subtitle) && memesOrSocial) {
          entReason = `Search entity panel (${entLabel})`;
        } else if (ENTITY_GAME_RE.test(subtitle) && blockedSet.has('video games')) {
          entReason = `Search entity panel (${entLabel})`;
        } else if (ENTITY_GAMBLING_RE.test(subtitle) && blockedSet.has('gambling and betting')) {
          entReason = `Search entity panel (${entLabel})`;
        }
        if (entReason) {
          if (maskElement(leader, 'serp-shelf', entReason, true, followers)) maskedShelves++;
          continue;
        }
        // Ambiguous entity (e.g. "Python — Programming language" vs
        // "Fortnite — 2017 video game" phrased oddly): ask the classifier.
        const itemId = nextId('sb-entity');
        leader.setAttribute('data-smartblocker-id', itemId);
        leader.setAttribute('data-smartblocker-state', 'evaluated');
        for (let f = 0; f < followers.length; f++) {
          followers[f].setAttribute('data-smartblocker-follow', itemId);
        }
        pendingEval.push({
          id: itemId,
          url: location.href,
          title: entTitle,
          channel: 'Search entity panel',
          context: [subtitle, description].filter(Boolean).join('. ').slice(0, 260),
          kind: 'serp-card',
        });
      }

      // 5. Leftover-link sweep: SERP modules change markup constantly, so as a
      // DOM-agnostic backstop mask any remaining link to a known distraction
      // host (entity-hero video tiles, social-profile rows, Q&A answers, …).
      // The masked unit is the largest enclosing "tile" whose external links
      // ALL point at distraction-type hosts — never a container that also
      // holds a productive result.
      const SWEEP_STOP_SEL =
        '#rso, #center_col, #rhs, #rcnt, #search, #main, #botstuff, #b_results, #b_content, #b_context, #links, body, html';
      const SWEEP_TILE_SEL = '[data-attrid], [data-hveid], g-inner-card, .MjjYud, li, article';
      const isSerpInternalHost = (h: string): boolean =>
        h === hostLower ||
        /^(?:google\.[a-z.]+|bing\.com|duckduckgo\.com|(?:[a-z0-9-]+\.)?gstatic\.com|(?:support|policies|accounts|maps|translate|lens|myactivity)\.google\.[a-z.]+)$/i.test(
          h,
        );
      const sweepReason = (h: string): string | null => {
        if (VIDEO_SOCIAL_HOST_RE.test(h) && memesOrSocial) return `video / social link (${h})`;
        if (GAMING_HOST_RE.test(h) && blockedSet.has('video games')) {
          return `video games link (${h})`;
        }
        if (GAMBLING_HOST_RE.test(h) && blockedSet.has('gambling and betting')) {
          return `gambling link (${h})`;
        }
        return null;
      };
      const isDistractionTypeHost = (h: string): boolean =>
        VIDEO_SOCIAL_HOST_RE.test(h) ||
        GAMING_HOST_RE.test(h) ||
        GAMBLING_HOST_RE.test(h) ||
        STREAMING_MOVIE_HOST_RE.test(h) ||
        SHOPPING_HOST_RE.test(h);
      const linkHost = (a: Element): string =>
        normHost(resolveResultHref((a as HTMLAnchorElement).getAttribute('href') || ''));
      const linksArePure = (el: Element): boolean => {
        const as = el.querySelectorAll('a[href]');
        for (let k = 0; k < as.length; k++) {
          const h = linkHost(as[k]);
          if (!h || isSerpInternalHost(h)) continue;
          if (!isDistractionTypeHost(h)) return false;
        }
        return true;
      };
      const sweepTile = (a: Element): Element => {
        let best: Element = a;
        let el = a.parentElement;
        for (let d = 0; el && d < 12; d++) {
          if (el.matches(SWEEP_STOP_SEL) || el.querySelector('#rso, #center_col, #rhs')) break;
          if (textOf(el).length > 1500 || !linksArePure(el)) break;
          if (el.matches(SWEEP_TILE_SEL)) {
            best = el;
            if (el.hasAttribute('data-attrid')) break; // Google's own tile boundary
          }
          el = el.parentElement;
        }
        return best;
      };

      const sweepLinks = document.querySelectorAll(
        '#rcnt a[href], #botstuff a[href], #b_content a[href], #links a[href], section[data-testid="mainline"] a[href], section[data-area="mainline"] a[href]',
      );
      for (let i = 0; i < sweepLinks.length; i++) {
        const a = sweepLinks[i];
        if (a.closest('[data-smartblocker-masked]')) continue;
        const reason = sweepReason(linkHost(a));
        if (!reason) continue;
        const tile = sweepTile(a);
        if (tile.closest('[data-smartblocker-masked]')) continue;
        if (maskElement(tile, 'serp-card', reason)) maskedCards++;
      }
      }
    }

    // Dispatch pending embeds & SERP cards to the background service worker
    if (
      pendingEval.length > 0 &&
      typeof chrome !== 'undefined' &&
      chrome.runtime?.sendMessage
    ) {
      try {
        chrome.runtime.sendMessage(
          { type: 'EVAL_SUBITEMS', items: pendingEval },
          (resp?: { ok?: boolean; results?: SubItemEvalResult[] }) => {
            if (!resp?.ok || !Array.isArray(resp.results)) return;
            for (let i = 0; i < resp.results.length; i++) {
              const r = resp.results[i];
              const target = findBySmartBlockerId(r.id);
              if (!target) continue;
              if (r.blocked) {
                const isEmbed =
                  r.id.startsWith('sb-embed') ||
                  r.id.startsWith('sb-facade') ||
                  r.id.startsWith('sb-chatlink');
                const titleHint = r.resolvedTitle ? `"${r.resolvedTitle.slice(0, 48)}" — ` : '';
                const followers = Array.from(
                  document.querySelectorAll(`[data-smartblocker-follow="${r.id}"]`),
                );
                maskElement(
                  target,
                  isEmbed ? 'embed' : 'serp-card',
                  `${titleHint}${r.label}`,
                  true,
                  followers,
                );
              } else {
                target.setAttribute('data-smartblocker-state', 'allowed');
              }
            }
          },
        );
      } catch {
        // ignore messaging error if extension context invalidated
      }
    }

    return {
      maskedShelves,
      maskedCards,
      maskedEmbeds,
      pendingItems: pendingEval.length,
    };
  }

  // Register a single debounced MutationObserver per page so lazy-loaded
  // SERP shelves (c-wiz) and newly pasted chatbot videos are caught automatically.
  if (!win.__sbSanitizeObserver && document.documentElement) {
    const obs = new MutationObserver(() => {
      if (win.__sbSanitizeTimer) clearTimeout(win.__sbSanitizeTimer);
      win.__sbSanitizeTimer = window.setTimeout(() => {
        win.__sbSanitizeTimer = undefined;
        runScan();
      }, 140);
    });
    obs.observe(document.documentElement, {
      childList: true,
      subtree: true,
      // Also watch the handful of attributes the sanitizer keys on (#16):
      // without attribute observation a hostile page could point an existing
      // about:blank iframe back at masked media (src family) or tamper with
      // mask state — all without a childList mutation. Bounded by
      // attributeFilter; our own state writes settle after one debounced
      // no-op re-scan.
      attributes: true,
      attributeFilter: [
        'src',
        'srcdoc',
        'data-src',
        'data-lazy-src',
        'data-original',
        'videoid',
        'data-videoid',
        'data-video-id',
        'data-smartblocker-masked',
        'data-smartblocker-state',
      ],
    });
    win.__sbSanitizeObserver = obs;
  }

  return runScan();
}
