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
    const channel = metaContent('og:site_name') || metaContent('author');
    const context = trimTo(
      metaContent('description') || metaContent('og:description'),
      SNIPPET_LEN,
    );
    const result: { channel?: string; context?: string } = {};
    if (channel) result.channel = channel;
    if (context) result.context = context;
    return result;
  } catch {
    return {};
  }
}
