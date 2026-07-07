// Injected into the page via scripting.executeScript({ func: extractMeta }).
// SERIALIZATION RULE: this function must be fully self-contained — NO imports,
// NO closures over module scope, no TypeScript-only constructs that don't
// survive function serialisation (same constraint as src/background/overlay.ts).

/**
 * Extract richer page signals from the live DOM.
 *
 * Returns { channel?, context? } where:
 *   channel — uploader/subreddit name
 *   context — description/post-body snippet (first ~200 chars)
 *
 * All selectors are tried defensively; partial results are fine.
 * Never throws — always returns at least {}.
 */
export function extractMeta(): { channel?: string; context?: string } {
  // NOTE: this function body is serialised by executeScript — keep it
  // fully self-contained.  The `export` keyword is stripped at call time
  // (TypeScript emits the body; the TS compiler removes the keyword when
  // the caller passes the function reference directly).

  const SNIPPET_LEN = 200;

  function trimTo(s: string, len: number): string {
    s = s.trim();
    return s.length > len ? s.slice(0, len).trimEnd() : s;
  }

  function textOf(el: Element | null): string {
    if (!el) return '';
    return (el.textContent ?? '').trim();
  }

  function attr(el: Element | null, name: string): string {
    if (!el) return '';
    return (el.getAttribute(name) ?? '').trim();
  }

  function metaContent(name: string): string {
    const el =
      document.querySelector(`meta[name="${name}"]`) ??
      document.querySelector(`meta[property="${name}"]`);
    return attr(el, 'content');
  }

  try {
    const url = location.href;

    // ── YouTube watch pages ──────────────────────────────────────────────────
    const isYouTube = /youtube\.com\/(watch|shorts\/)/i.test(url);
    if (isYouTube) {
      let channel = '';

      // Try selectors in order of reliability.
      const channelSelectors = [
        'ytd-channel-name a',
        'ytd-video-owner-renderer yt-formatted-string a',
        'ytd-video-owner-renderer a',
        '#channel-name a',
        // Links to channel pages: /@ChannelHandle
        'a[href*="/@"]',
      ];
      for (const sel of channelSelectors) {
        const el = document.querySelector(sel);
        const text = textOf(el);
        if (text) {
          channel = text;
          break;
        }
      }

      // Fallback: og:channel_name or author meta
      if (!channel) channel = metaContent('author');

      let context = '';
      const descSelectors = [
        '#description ytd-text-inline-expander',
        'ytd-text-inline-expander',
        '#description-text',
        '#description',
        'ytd-expander #content',
      ];
      for (const sel of descSelectors) {
        const el = document.querySelector(sel);
        const text = textOf(el);
        if (text) {
          context = trimTo(text, SNIPPET_LEN);
          break;
        }
      }
      // Last resort: <meta name="description">
      if (!context) context = trimTo(metaContent('description'), SNIPPET_LEN);

      const result: { channel?: string; context?: string } = {};
      if (channel) result.channel = channel;
      if (context) result.context = context;
      return result;
    }

    // ── Reddit comments pages ────────────────────────────────────────────────
    const isReddit = /reddit\.com\/r\/[^/]+\/comments\//i.test(url);
    if (isReddit) {
      let channel = '';

      // New Reddit: <shreddit-subreddit-header> or a link element for /r/<name>.
      // Old Reddit: a.subreddit with text "r/<name>".
      const srSelectors = [
        // New Reddit breadcrumb / header link
        'a[href^="/r/"][data-testid="subreddit-title"]',
        'shreddit-subreddit-header',
        'a[href^="/r/"].subreddit-name',
        // Old Reddit sidebar / breadcrumb
        'a.subreddit.hover',
        '#header-img-a',            // sometimes has subreddit name
      ];
      for (const sel of srSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          // Prefer href-derived name (more reliable than text content).
          const href = attr(el, 'href');
          const m = href.match(/\/r\/([\w]+)/);
          if (m) { channel = 'r/' + m[1]; break; }
          // Fall back to text
          const text = textOf(el).replace(/^r\//, '');
          if (text) { channel = 'r/' + text; break; }
        }
      }

      // Fallback: parse /r/<name> from the URL itself.
      if (!channel) {
        const m = url.match(/reddit\.com\/r\/([\w]+)/);
        if (m) channel = 'r/' + m[1];
      }

      let context = '';
      // New Reddit uses <shreddit-post> or div[data-post-content].
      // Old Reddit uses div[data-test-id="post-content"] or .usertext-body.
      const postSelectors = [
        '[data-test-id="post-content"] .RichTextJSON-root',
        '[data-test-id="post-content"] .md',
        '.usertext-body .md',
        'shreddit-post [slot="text-body"]',
        '[data-post-content] p',
        '.Post__title + div p',  // generic fallback for some Reddit layouts
      ];
      for (const sel of postSelectors) {
        const el = document.querySelector(sel);
        const text = textOf(el);
        if (text) {
          context = trimTo(text, SNIPPET_LEN);
          break;
        }
      }
      // Last resort: meta description (Reddit usually puts post text there).
      if (!context) context = trimTo(metaContent('description'), SNIPPET_LEN);

      const result: { channel?: string; context?: string } = {};
      if (channel) result.channel = channel;
      if (context) result.context = context;
      return result;
    }

    // ── Generic page (any other site) ────────────────────────────────────────
    // FlowGuard now classifies all sites; give the model whatever signal the
    // page exposes via standard metadata. All fields stay optional.

    // Page-kind hint from og:type + JSON-LD @type. Pages self-declare what
    // they are ("product", "Movie", "NewsArticle"); mapping the unambiguous
    // kinds to a short sentence PREPENDED to the context anchors the
    // classifier far better than marketing copy alone (apple.com's spec-heavy
    // og:description reads like a tech article; "Online store product page."
    // does not). Only high-precision kinds are mapped — generic ones
    // (website, article, VideoObject) say nothing about the category.
    function pageKindHint(): string {
      const types = new Set<string>();
      const og = metaContent('og:type').toLowerCase();
      if (og) types.add(og);
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (let i = 0; i < scripts.length && i < 8; i++) {
        const raw = scripts[i].textContent ?? '';
        if (!raw || raw.length > 200000) continue;
        // Regex scan instead of JSON.parse: cheap, and robust to the malformed
        // JSON-LD found in the wild. Handles "@type": "X" and "@type": ["X",…].
        const matches = raw.match(/"@type"\s*:\s*(\[[^\]]*\]|"[^"]*")/g) ?? [];
        for (const m of matches) {
          for (const t of m.match(/"([\w.]+)"/g) ?? []) {
            const name = t.slice(1, -1).toLowerCase();
            if (name !== '@type') types.add(name);
          }
        }
      }
      const has = (...names: string[]) => names.some((n) => types.has(n));
      // Institutional identities first: a bank describing a credit card also
      // declares Product, but "who the site is" (bank/gov/school) grounds the
      // classifier better than "what this page sells" — these are exactly the
      // pages whose sparse account/sign-in titles drift into social media.
      if (has('bankorcreditunion', 'financialservice', 'bankaccount', 'creditcard')) {
        return 'Bank or financial institution page.';
      }
      if (has('governmentorganization', 'governmentoffice', 'governmentservice')) {
        return 'Government services page.';
      }
      if (has('educationalorganization', 'collegeoruniversity', 'school', 'university')) {
        return 'University or school page.';
      }
      if (has('hospital', 'medicalorganization', 'medicalclinic', 'physician')) {
        return 'Medical provider page.';
      }
      if (has('insuranceagency')) return 'Insurance company page.';
      if (has('product', 'productgroup', 'offer', 'aggregateoffer', 'product.group')) {
        return 'Online store product page.';
      }
      if (has('video.movie', 'video.episode', 'video.tv_show', 'movie', 'tvseries', 'tvepisode')) {
        return 'Movie or TV show page.';
      }
      if (has('music.song', 'music.album', 'music.playlist', 'musicrecording', 'musicalbum')) {
        return 'Music page.';
      }
      if (has('videogame', 'game')) return 'Video game page.';
      if (has('newsarticle', 'reportagenewsarticle', 'liveblogposting')) return 'News article.';
      if (has('recipe')) return 'Recipe page.';
      return '';
    }

    // Nav-link fingerprint: a site's own navigation is a strong site-type
    // signature ("Accounts · Transfers · Bill Payments" vs "Home · Explore ·
    // Reels"), and it exists on exactly the legacy bank/gov/utility sites
    // that ship no og: metadata. Only used when the description signal is
    // missing or short, so it never dilutes a good description.
    function navFingerprint(): string {
      const links = document.querySelectorAll('header a, nav a');
      const texts: string[] = [];
      for (let i = 0; i < links.length && texts.length < 8; i++) {
        const t = (links[i].textContent ?? '').trim().replace(/\s+/g, ' ');
        if (!t || t.length > 24 || texts.indexOf(t) !== -1) continue;
        texts.push(t);
      }
      return trimTo(texts.join(' · '), 80);
    }

    const channel = metaContent('og:site_name') || metaContent('author');
    let body = metaContent('description') || metaContent('og:description');
    if (!body) {
      // No description meta: the top heading is the next-best summary (helps
      // SPAs whose <title> is sparse, e.g. "Home" or a bare brand name).
      const h1 = trimTo(textOf(document.querySelector('h1')), 80);
      if (h1 && !document.title.toLowerCase().includes(h1.toLowerCase())) body = h1;
    }
    if (!body || body.length < 80) {
      const nav = navFingerprint();
      if (nav) body = [body, nav].filter(Boolean).join(' ');
    }
    // A password field marks account/auth pages — almost never the distraction
    // itself, and exactly the pages whose sparse titles ("Sign In", "Verify
    // your identity") otherwise drift into the social media centroid.
    const signIn = document.querySelector('input[type="password"]') ? 'Account sign-in page.' : '';
    const hint = pageKindHint();
    const context = trimTo([signIn, hint, body].filter(Boolean).join(' '), SNIPPET_LEN);
    const result: { channel?: string; context?: string } = {};
    if (channel) result.channel = channel;
    if (context) result.context = context;
    return result;
  } catch {
    return {};
  }
}
