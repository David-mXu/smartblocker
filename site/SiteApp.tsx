import React, { useRef } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { useGSAP } from '@gsap/react';
import {
  ShieldCheck,
  Cpu,
  Lightning,
  Fingerprint,
  EyeSlash,
  Sparkle,
  ArrowUpRight,
  ArrowDown,
  LockKey,
  GithubLogo,
} from '@phosphor-icons/react';
import heroPillImg from '../src/assets/showcase/hero-pill.svg';
import monolithImg from '../src/assets/showcase/monolith.svg';
import prismOneImg from '../src/assets/showcase/prism-one.svg';
import prismTwoImg from '../src/assets/showcase/prism-two.svg';
import prismThreeImg from '../src/assets/showcase/prism-three.svg';
import ladderGateImg from '../src/assets/showcase/ladder-gate.svg';
import ladderCorridorImg from '../src/assets/showcase/ladder-corridor.svg';
import ladderLatticeImg from '../src/assets/showcase/ladder-lattice.svg';

gsap.registerPlugin(ScrollTrigger, useGSAP);

const GITHUB_URL = 'https://github.com/David-mXu/smartblocker';
const GITHUB_RELEASES_URL = 'https://github.com/David-mXu/smartblocker/releases';
const PRIVACY_URL = 'https://github.com/David-mXu/smartblocker/blob/main/PRIVACY.md';
const ROADMAP_URL = 'https://github.com/David-mXu/smartblocker/blob/main/ROADMAP.md';

/* Styled-anchor equivalents of the options page's ui/button variants
 * (the site does not import from src/components), keeping the exact
 * visual language of the snapshot. */
const BTN_BASE =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 cursor-pointer select-none active:scale-[0.99]';
const BTN_LG = 'h-12 rounded-xl px-7 text-base';
const BTN_PRIMARY = 'bg-primary text-primary-foreground font-semibold hover:bg-primary/95';
const BTN_SECONDARY =
  'bg-secondary text-foreground border border-border hover:bg-muted/90 hover:border-input';

const MANIFESTO_TEXT =
  'Legacy blockers amputate whole domains because they cannot read. SmartBlocker embeds every title locally in twelve milliseconds, separating deep engineering research from algorithmic rabbit holes without a single packet ever leaving your machine.';

const ACCORDION_PANELS = [
  {
    title: 'Domain Whitelist & Pre-Curtain Gate',
    subtitle: 'Zero-latency exemption and 180ms media suppression',
    description:
      'Whitelisted domains and subdomains bypass inference immediately. On mixed high-risk hosts like YouTube, Reddit, and Twitch, an immediate pre-classification curtain pauses active media before a single frame distracts you.',
    image: ladderGateImg,
  },
  {
    title: 'Deterministic Substring Blocklist',
    subtitle: 'Instant URL and query interception',
    description:
      'Unambiguous patterns in the full URL or page title trigger the block screen in zero milliseconds without waking the neural pipeline—catching shopping carts, impulse queries, and distracting storefronts.',
    image: ladderCorridorImg,
  },
  {
    title: 'BGE-Small Multi-Prototype Centroids',
    subtitle: '384-dimensional local vector geometry',
    description:
      'Each page is embedded once via ONNX WASM and scored against multi-cluster category prototypes, neutral productive anchors, and your active Focus Context vector—updating centroids on-device whenever you record a correction.',
    image: ladderLatticeImg,
  },
] as const;

const PINNED_CHAPTERS = [
  {
    title: 'Sub-15ms Offscreen WASM Inference',
    detail:
      'Hosted inside a persistent offscreen document so service-worker sleep cycles never force a cold model reload.',
    image: prismOneImg,
  },
  {
    title: 'Monotonic Commitment Convergence',
    detail:
      'Timer locks, password hashes, Frozen Turkey sessions, and recurring schedules merge monotonically across browser and native daemon.',
    image: prismTwoImg,
  },
  {
    title: 'On-Device Centroid Personalization',
    detail:
      'False positives and false negatives fold directly into local prototype centroids—adapting to your exact discipline without cloud training.',
    image: prismThreeImg,
  },
] as const;

const PRIVACY_CARDS = [
  {
    title: '100% local ONNX WASM inference',
    detail:
      'Every classification runs inside your browser. Page titles never touch a network socket.',
    icon: Cpu,
  },
  {
    title: 'Zero cloud telemetry',
    detail: 'No analytics, no tracking, no beacons. Opt-in anonymous corrections only.',
    icon: EyeSlash,
  },
  {
    title: 'Open source — auditable on GitHub',
    detail: 'Every line of the pipeline is public. Read the privacy policy and verify the build.',
    icon: LockKey,
    href: PRIVACY_URL,
  },
] as const;

export function SiteApp() {
  const mainRef = useRef<HTMLElement>(null);
  const scrubRef = useRef<HTMLParagraphElement>(null);
  const pinSectionRef = useRef<HTMLDivElement>(null);
  const pinLeftRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      // Hero entrance
      gsap.from('.hero-reveal', {
        y: 28,
        opacity: 0,
        duration: 0.9,
        stagger: 0.12,
        ease: 'power3.out',
      });

      // Scrubbing text reveal on manifesto words
      if (scrubRef.current) {
        const words = scrubRef.current.querySelectorAll('.scrub-word');
        if (words.length > 0) {
          gsap.fromTo(
            words,
            { opacity: 0.12 },
            {
              opacity: 1,
              stagger: 0.05,
              ease: 'none',
              scrollTrigger: {
                trigger: scrubRef.current,
                start: 'top 82%',
                end: 'bottom 45%',
                scrub: true,
              },
            },
          );
        }
      }

      // Pinning left column in split showcase
      if (pinSectionRef.current && pinLeftRef.current) {
        ScrollTrigger.create({
          trigger: pinSectionRef.current,
          start: 'top 18%',
          end: 'bottom 75%',
          pin: pinLeftRef.current,
          pinSpacing: false,
        });
      }

      // Image Scale & Fade Scroll on showcase cards
      const scaleCards = gsap.utils.toArray<HTMLElement>('.gsap-scale-card');
      for (const card of scaleCards) {
        gsap.fromTo(
          card,
          { scale: 0.84, opacity: 0.35 },
          {
            scale: 1,
            opacity: 1,
            ease: 'power2.out',
            scrollTrigger: {
              trigger: card,
              start: 'top 88%',
              end: 'top 35%',
              scrub: true,
            },
          },
        );
      }
    },
    { scope: mainRef },
  );

  return (
    <main
      ref={mainRef}
      className="overflow-x-hidden w-full max-w-full min-h-screen bg-background text-foreground relative"
    >
      {/* Background atmospheric mesh & architectural grid */}
      <div className="pointer-events-none fixed inset-0 bg-editorial-grid opacity-55" />
      <div className="pointer-events-none fixed -top-48 left-1/4 h-[520px] w-[720px] rounded-full bg-accent/[0.06] blur-[150px]" />
      <div className="pointer-events-none fixed bottom-0 right-1/4 h-[460px] w-[640px] rounded-full bg-muted-foreground/[0.05] blur-[140px]" />

      {/* FLOATING GLASS-PILL NAVIGATION BAR */}
      <header className="fixed top-5 inset-x-0 z-50 mx-auto max-w-6xl px-4 md:px-8">
        <nav className="flex items-center justify-between rounded-full border border-border bg-card/80 px-5 py-2.5 shadow-[0_20px_50px_rgba(0,0,0,0.75)] backdrop-blur-2xl">
          <a href="#" className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-secondary">
              <ShieldCheck weight="duotone" className="h-4.5 w-4.5 text-accent" />
            </div>
            <span className="text-sm font-semibold tracking-tight text-foreground">
              SmartBlocker
            </span>
          </a>

          <div className="hidden md:flex items-center gap-7 text-xs font-medium text-muted-foreground">
            <a href="#architecture" className="hover:text-foreground transition-colors">
              Architecture
            </a>
            <a href="#pipeline" className="hover:text-foreground transition-colors">
              Pipeline
            </a>
            <a href="#privacy" className="hover:text-foreground transition-colors">
              Privacy
            </a>
          </div>

          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={`${BTN_BASE} ${BTN_PRIMARY} h-8 rounded-full px-4 text-xs`}
          >
            Get the extension
          </a>
        </nav>
      </header>

      {/* =====================================================================
          HERO: EDITORIAL SPLIT (py-32 md:py-48)
         ===================================================================== */}
      <section className="relative z-10 mx-auto max-w-7xl px-6 md:px-12 py-32 md:py-48">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 lg:gap-16 items-center">
          {/* Left: Wide Editorial Typography (2 Lines Guaranteed) */}
          <div className="lg:col-span-8 flex flex-col items-start">
            <h1 className="hero-reveal max-w-5xl w-full text-[clamp(2.5rem,4.0vw,4.35rem)] font-semibold leading-[1.08] tracking-[-0.035em] text-foreground">
              Silence the impulse,
              <br className="hidden sm:block" />
              <span className="inline-flex overflow-hidden w-24 h-11 md:w-28 md:h-12 rounded-full align-middle mr-3 border border-border contrast-125 shadow-inner">
                <img src={heroPillImg} alt="" className="h-full w-full object-cover" />
              </span>
              preserve the craft.
            </h1>

            <p className="hero-reveal mt-8 max-w-2xl text-lg md:text-xl leading-relaxed text-muted-foreground">
              SmartBlocker runs a local BGE-Small vector engine inside your browser to evaluate page
              semantics in real time—allowing technical research through while intercepting
              algorithmic feeds before they play.
            </p>

            <div className="hero-reveal mt-10 flex flex-wrap items-center gap-4">
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={`${BTN_BASE} ${BTN_LG} ${BTN_PRIMARY}`}
              >
                View on GitHub
                <ArrowUpRight weight="bold" className="h-4.5 w-4.5" />
              </a>
              <a href="#architecture" className={`${BTN_BASE} ${BTN_LG} ${BTN_SECONDARY}`}>
                See the architecture
                <ArrowDown weight="bold" className="h-4.5 w-4.5" />
              </a>
            </div>
          </div>

          {/* Right: Editorial Split Visual Monolith with Negative Space */}
          <div className="lg:col-span-4">
            <div className="hero-reveal group relative overflow-hidden rounded-3xl border border-border bg-background aspect-[4/5] shadow-[0_32px_80px_rgba(0,0,0,0.85)]">
              <img
                src={monolithImg}
                alt="Architectural concrete monolith"
                className="h-full w-full object-cover opacity-90 contrast-115 group-hover:scale-105 transition-transform duration-700 ease-out"
              />
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-background via-background/35 to-transparent" />
              <div className="absolute bottom-6 inset-x-6 flex flex-col gap-1">
                <span className="font-mono text-xs text-muted-foreground">
                  Xenova/bge-small-en-v1.5
                </span>
                <p className="text-sm font-medium text-foreground m-0">
                  Zero telemetry. Multi-prototype cosine similarity in local WASM.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* =====================================================================
          ARCHITECTURE: INFINITE MARQUEE, SCRUBBING MANIFESTO, PINNED SPLIT
          (py-32 md:py-48)
         ===================================================================== */}
      <section
        id="architecture"
        className="scroll-mt-24 relative z-10 py-32 md:py-48 border-t border-border/90"
      >
        {/* INFINITE MARQUEE */}
        <div className="w-full overflow-hidden border-y border-border bg-background py-6 mb-32">
          <div className="animate-marquee flex items-center gap-14">
            {[0, 1].map((dup) => (
              <div key={dup} className="flex items-center gap-14 shrink-0">
                <span className="flex items-center gap-3 text-xl md:text-2xl font-semibold tracking-tight text-foreground/80">
                  <Cpu className="h-6 w-6 text-accent" />
                  100% Local ONNX WASM
                </span>
                <span className="flex items-center gap-3 text-xl md:text-2xl font-semibold tracking-tight text-foreground/80">
                  <Lightning className="h-6 w-6 text-warning" />
                  Sub-15ms Title Embedding
                </span>
                <span className="flex items-center gap-3 text-xl md:text-2xl font-semibold tracking-tight text-foreground/80">
                  <Fingerprint className="h-6 w-6 text-accent" />
                  Multi-Prototype Centroids
                </span>
                <span className="flex items-center gap-3 text-xl md:text-2xl font-semibold tracking-tight text-foreground/80">
                  <EyeSlash className="h-6 w-6 text-muted-foreground" />
                  Zero Cloud Telemetry
                </span>
                <span className="flex items-center gap-3 text-xl md:text-2xl font-semibold tracking-tight text-foreground/80">
                  <Sparkle className="h-6 w-6 text-accent" />
                  97.6% E2E Decision Accuracy
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* GSAP SCRUBBING TEXT REVEAL */}
        <div id="manifesto-section" className="mx-auto max-w-6xl px-6 md:px-12 mb-36">
          <p
            ref={scrubRef}
            className="text-3xl md:text-5xl font-semibold leading-[1.18] tracking-tight text-foreground"
          >
            {MANIFESTO_TEXT.split(' ').map((word, idx) => (
              <span key={idx} className="scrub-word inline-block mr-[0.28em]">
                {word}
              </span>
            ))}
          </p>
        </div>

        {/* SCROLL PINNING SPLIT + IMAGE SCALE & FADE */}
        <div
          ref={pinSectionRef}
          className="mx-auto max-w-7xl px-6 md:px-12 grid grid-cols-1 lg:grid-cols-12 gap-12 items-start mb-20"
        >
          <div ref={pinLeftRef} className="lg:col-span-5 pr-4">
            <h2 className="text-3xl md:text-5xl font-semibold tracking-tight text-foreground leading-[1.08]">
              Engineered for Unbreakable Focus
            </h2>
            <p className="mt-5 text-base md:text-lg text-muted-foreground leading-relaxed">
              Every architectural layer is built to eliminate both latency and willpower loopholes—from
              persistent offscreen inference to native process watchdogs.
            </p>
          </div>

          <div className="lg:col-span-7 flex flex-col gap-12">
            {PINNED_CHAPTERS.map((item) => (
              <div
                key={item.title}
                className="gsap-scale-card group relative overflow-hidden rounded-3xl border border-border bg-card p-8 md:p-10"
              >
                <div className="overflow-hidden rounded-2xl border border-border mb-6 aspect-[16/9]">
                  <img
                    src={item.image}
                    alt={item.title}
                    className="h-full w-full object-cover opacity-90 contrast-115 group-hover:scale-105 transition-transform duration-700 ease-out"
                  />
                </div>
                <h3 className="text-2xl font-semibold text-foreground tracking-tight">
                  {item.title}
                </h3>
                <p className="mt-2 text-sm md:text-base text-muted-foreground leading-relaxed m-0">
                  {item.detail}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* =====================================================================
          PIPELINE: THREE-STAGE INTERCEPTION LADDER HORIZONTAL ACCORDION
         ===================================================================== */}
      <section
        id="pipeline"
        className="scroll-mt-24 relative z-10 py-32 md:py-48 border-t border-border/90"
      >
        <div className="mx-auto max-w-7xl px-6 md:px-12">
          <h3 className="text-2xl md:text-4xl font-semibold tracking-tight text-foreground mb-8">
            Three-Stage Interception Ladder
          </h3>
          <div className="flex flex-col md:flex-row gap-4 min-h-[420px]">
            {ACCORDION_PANELS.map((panel) => (
              <div
                key={panel.title}
                className="group relative flex-1 hover:flex-[2.4] transition-all duration-700 ease-out overflow-hidden rounded-3xl border border-border bg-card p-7 md:p-9 flex flex-col justify-end"
              >
                <img
                  src={panel.image}
                  alt={panel.title}
                  className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-35 contrast-115 group-hover:scale-105 group-hover:opacity-50 transition-all duration-700 ease-out"
                />
                <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-background via-background/80 to-transparent" />
                <div className="relative z-10">
                  <span className="font-mono text-xs text-accent">{panel.subtitle}</span>
                  <h4 className="mt-2 text-xl md:text-2xl font-semibold text-foreground tracking-tight">
                    {panel.title}
                  </h4>
                  <p className="mt-3 max-w-xl text-sm text-foreground/80 leading-relaxed opacity-85 group-hover:opacity-100 transition-opacity duration-500">
                    {panel.description}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* =====================================================================
          PRIVACY: COMPACT 3-CARD STRIP
         ===================================================================== */}
      <section
        id="privacy"
        className="scroll-mt-24 relative z-10 py-32 md:py-48 border-t border-border/90"
      >
        <div className="mx-auto max-w-7xl px-6 md:px-12">
          <div className="mb-14 max-w-3xl">
            <h2 className="text-3xl md:text-5xl font-semibold tracking-tight text-foreground leading-[1.08]">
              Private by Construction
            </h2>
            <p className="mt-4 text-base md:text-lg text-muted-foreground leading-relaxed">
              Privacy here is not a promise in a policy PDF — it is the absence of a network call.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {PRIVACY_CARDS.map((card) => {
              const inner = (
                <>
                  <card.icon weight="duotone" className="h-7 w-7 text-accent" />
                  <h3 className="mt-5 text-lg font-semibold tracking-tight text-foreground">
                    {card.title}
                  </h3>
                  <p className="mt-2 text-sm text-muted-foreground leading-relaxed m-0">{card.detail}</p>
                </>
              );
              const cls =
                'group relative overflow-hidden rounded-3xl border border-border bg-card/90 p-8 backdrop-blur-xl transition-all duration-300';
              return 'href' in card && card.href ? (
                <a
                  key={card.title}
                  href={card.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`${cls} block hover:border-muted-foreground/40 hover:bg-muted`}
                >
                  {inner}
                  <span className="mt-4 inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground/70 group-hover:text-accent transition-colors">
                    <ArrowUpRight weight="bold" className="h-3.5 w-3.5" />
                    PRIVACY.md
                  </span>
                </a>
              ) : (
                <div key={card.title} className={cls}>
                  {inner}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* =====================================================================
          FINAL CTA + FOOTER (py-32 md:py-48)
         ===================================================================== */}
      <footer className="relative z-10 border-t border-border">
        <div className="mx-auto max-w-7xl px-6 md:px-12 py-32 md:py-48">
          <div className="rounded-3xl border border-border bg-gradient-to-b from-muted to-background p-10 md:p-16 flex flex-col md:flex-row items-start md:items-center justify-between gap-8 shadow-[0_32px_90px_rgba(0,0,0,0.85)]">
            <div className="max-w-2xl">
              <h2 className="text-3xl md:text-5xl font-semibold tracking-tight text-foreground leading-[1.06]">
                Stop blocking the whole internet. Start blocking your bad habits.
              </h2>
              <p className="mt-4 text-base text-muted-foreground leading-relaxed m-0">
                Chrome Web Store listing — coming soon.
              </p>
            </div>

            <a
              href={GITHUB_RELEASES_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={`${BTN_BASE} ${BTN_LG} ${BTN_PRIMARY} shrink-0`}
            >
              <GithubLogo weight="bold" className="h-5 w-5" />
              Install from GitHub Releases
            </a>
          </div>

          <div className="mt-16 flex flex-col md:flex-row items-start md:items-center justify-between gap-6 text-xs text-muted-foreground/70">
            <span className="font-medium text-muted-foreground">SmartBlocker v0.5.0</span>
            <nav className="flex flex-wrap items-center gap-6 font-medium">
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-foreground transition-colors"
              >
                GitHub
              </a>
              <a
                href={PRIVACY_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-foreground transition-colors"
              >
                PRIVACY.md
              </a>
              <a
                href={ROADMAP_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-foreground transition-colors"
              >
                ROADMAP.md
              </a>
            </nav>
            <span>All classification happens on your device.</span>
          </div>
        </div>
      </footer>
    </main>
  );
}
