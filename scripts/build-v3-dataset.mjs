// Builds and appends the comprehensive `set: "v3"` evaluation slice to
// scripts/eval-dataset.json (idempotent: replaces any existing `set === "v3"`
// entries while keeping all v1 and v2 entries 100% untouched).
import { readFileSync, writeFileSync } from 'node:fs';

const DATASET_URL = new URL('./eval-dataset.json', import.meta.url);
const dataset = JSON.parse(readFileSync(DATASET_URL, 'utf8'));

// Preserve all non-v3 cases (v1 = 274, v2 = 121 -> 395 cases)
const baseCases = dataset.cases.filter((c) => c.set !== 'v3');

const NC = 'v3 benchmark case — scored on authored signals';

function yt(id, title, channel, context, expected, note) {
  return {
    url: `https://www.youtube.com/watch?v=${id}`,
    input: { title, channel, context },
    expected,
    set: 'v3',
    noCapture: NC,
    ...(note ? { note } : {}),
  };
}

function ytShort(id, title, channel, context, expected, note) {
  return {
    url: `https://www.youtube.com/shorts/${id}`,
    input: { title, channel, context },
    expected,
    set: 'v3',
    noCapture: NC,
    ...(note ? { note } : {}),
  };
}

function reddit(sub, slug, title, context, expected, note) {
  return {
    url: `https://www.reddit.com/r/${sub}/comments/${slug}/`,
    input: { title, channel: `r/${sub}`, context },
    expected,
    set: 'v3',
    noCapture: NC,
    ...(note ? { note } : {}),
  };
}

function web(url, title, channel, context, expected, note) {
  const input = { title };
  if (channel !== undefined) input.channel = channel;
  if (context !== undefined) input.context = context;
  return {
    url,
    input,
    expected,
    set: 'v3',
    noCapture: NC,
    ...(note ? { note } : {}),
  };
}

const v3Cases = [
  // ══════════════════════════════════════════════════════════════════════════
  // COHORT 1: YouTube Productive vs. Distraction (100 cases)
  // Tests nuanced disambiguation on youtube.com/watch and youtube.com/shorts
  // using title + channel + description context.
  // ══════════════════════════════════════════════════════════════════════════

  // --- YouTube Productive: Computer Science, Programming & Systems (18) ---
  yt('v3yt001', 'Lecture 15: B+ Trees and Index Concurrency Control', 'CMU Database Group', 'Andy Pavlo 15-445/645 Intro to Database Systems lecture covering latch crabbing, B-link trees, and index locking.', ['programming and software development', 'science and education']),
  yt('v3yt002', 'Implementing the Raft Consensus Algorithm in Go', 'MIT 6.5840 Distributed Systems', 'Leader election, log replication, safety properties, and split-vote recovery in distributed state machines.', ['programming and software development', 'science and education']),
  yt('v3yt003', 'Lifetimes, Subtyping, and Variance in Rust', 'Jon Gjengset', 'Crust of Rust deep dive into covariance, contravariance, invariance, PhantomData, and borrow checker lifetimes.', ['programming and software development']),
  yt('v3yt004', 'Writing an x86_64 OS Kernel from Scratch: Page Tables', 'Low Level Learning', 'Setting up 4-level paging, identity mapping, page fault handlers, and virtual memory management in C and assembly.', ['programming and software development']),
  yt('v3yt005', 'How LLVM Optimizes Loops: Scalar Evolution & Vectorization', 'LLVM Developers Meeting', 'Compiler pass pipeline walkthrough: loop invariant code motion, unrolling, and SIMD auto-vectorization.', ['programming and software development']),
  yt('v3yt006', 'Zero-Copy Deserialization and Arena Allocators in C++23', 'CppCon', 'High-performance memory layout, custom pmr allocators, cache locality, and avoiding heap fragmentation.', ['programming and software development']),
  yt('v3yt007', 'React Server Components & Streaming SSR Architecture Explained', 'Theo - t3.gg', 'Breaking down RSC wire format, Suspense boundaries, hydration waterfalls, and Next.js App Router internals.', ['programming and software development']),
  yt('v3yt008', 'Debugging a Production Linux Kernel Panic with bpftrace', 'Brendan Gregg', 'Using eBPF kprobes, stack traces, and flame graphs to isolate tail-latency spikes in network sockets.', ['programming and software development']),
  yt('v3yt009', 'Building a Raytracer in WebGPU Compute Shaders', 'Sebastague', 'Implementing BVH acceleration structures, path tracing, importance sampling, and WGSL shaders from scratch.', ['programming and software development']),
  yt('v3yt010', 'PostgreSQL MVCC, Vacuuming, and Transaction Wraparound', 'Hussein Nasser', 'How Postgres stores tuple visibility, XID wraparound freeze limits, dead tuples, and WAL checkpoint tuning.', ['programming and software development']),
  yt('v3yt011', 'Designing a Rate Limiter and Token Bucket at Scale', 'ByteByteGo', 'System design interview walkthrough: Redis Lua scripts, sliding window counters, and distributed API gateways.', ['programming and software development']),
  yt('v3yt012', 'Neovim Lua Plugin Development: Treesitter & LSP Client', 'TJ DeVries', 'Configuring custom AST queries, diagnostic handlers, and asynchronous buffer autocommands in Neovim.', ['programming and software development']),
  yt('v3yt013', 'Understanding Transformer KV-Cache & FlashAttention-2 Math', 'Umar Jamil', 'Step-by-step derivation of tiled matrix multiplication in SRAM, online softmax rescaling, and memory bandwidth.', ['programming and software development', 'science and education']),
  yt('v3yt014', 'Wireshark Packet Analysis: Debugging TLS 1.3 Handshakes', 'Chris Greer', 'Inspecting ClientHello, key share extensions, cipher suites, and TCP retransmission timers in pcap captures.', ['programming and software development']),
  yt('v3yt015', 'Zig Comptime Metaprogramming for Embedded ARM Cortex-M', 'EmbeddedFM', 'Generating type-safe MMIO register definitions and interrupt vector tables at compile time without macros.', ['programming and software development']),
  yt('v3yt016', 'Git Internals: Content-Addressable Blobs, Trees, and Packfiles', 'Scott Chacon', 'Inspecting .git/objects with git cat-file, delta compression in packfiles, and reflog recovery.', ['programming and software development']),
  yt('v3yt017', 'Why Your Docker Containers Are Slow on macOS and WSL2', 'DevOps Directive', 'VirtioFS benchmarks, bind mount filesystem overhead, multi-stage build caching, and containerd layers.', ['programming and software development']),
  yt('v3yt018', 'Formal Verification with TLA+ for Distributed Storage', ' Hillel Wayne', 'Writing temporal logic specifications, invariants, and model checking concurrent state machines.', ['programming and software development', 'science and education']),

  // --- YouTube Productive: Math, Science, Medicine, CAD, DIY, Finance, Languages (24) ---
  yt('v3yt019', 'But what is a Fourier Series? Heat Flow & Complex Epicycles', '3Blue1Brown', 'Visualizing trigonometric orthogonality, complex exponentials, and the heat equation on a ring.', ['science and education']),
  yt('v3yt020', 'Tensor Calculus 8: Covariant Derivatives and Christoffel Symbols', 'eigenchris', 'Differential geometry lecture deriving parallel transport on curved manifolds and metric compatibility.', ['science and education']),
  yt('v3yt021', 'Renal Physiology: Loop of Henle Countercurrent Multiplier', 'Ninja Nerd', 'Medical school lecture on nephron tubular reabsorption, vasa recta osmolarity gradients, and aldosterone.', ['science and education']),
  yt('v3yt022', 'Acute Coronary Syndrome: ECG STEMI Localization & Troponins', 'Osmosis from Elsevier', 'Pathophysiology of atherosclerotic plaque rupture, contiguous lead ST elevation, and cath lab reperfusion.', ['science and education']),
  yt('v3yt023', 'Organic Chemistry: Diels-Alder Pericyclic Stereochemistry', 'The Organic Chemistry Tutor', 'Endo vs exo rule, diene s-cis conformation, frontier molecular orbitals, and regioselectivity practice problems.', ['science and education']),
  yt('v3yt024', 'Lecture 22: Noether Theorem and Conservation Laws in Lagrangian Mechanics', 'MIT OpenCourseWare', 'Classical mechanics 8.09 lecture proving continuous symmetries yield conserved conjugate momenta.', ['science and education']),
  yt('v3yt025', 'FreeCAD 1.0 Parametric Assembly & Topological Naming Fix Tutorial', 'MangoJelly Solutions for FreeCAD', 'Creating fully constrained 3D mechanical sketches, datum planes, STEP exports, and sheet metal bends.', 'productive'),
  yt('v3yt026', 'KiCad 8 4-Layer PCB Layout: Differential Pair Impedance & Ground Pour', 'Phil\'s Lab', 'Routing high-speed USB 2.0 differential traces, decoupling capacitor placement, and DRC manufacturing checks.', 'productive'),
  yt('v3yt027', 'Blender 4.2 Hard-Surface Precision Modeling for 3D Printing', 'Maker Tales', 'Manifold mesh boolean workflows, bevel modifiers, wall thickness checks, and exporting STL files for PrusaSlicer.', 'productive'),
  yt('v3yt028', 'How to Diagnose and Replace a Bad Alternator or Starter Solenoid', 'ChrisFix', 'Using a digital multimeter to test battery voltage drop, parasitic draw, and serpentine belt tension.', 'productive'),
  yt('v3yt029', 'Soldering Copper Pipe & Replacing a Frost-Free Hose Bib Valve', 'Got2Learn', 'Plumbing repair tutorial: flux application, MAPP gas torch technique, PEX crimp rings, and shutoff valves.', 'productive'),
  yt('v3yt030', 'MacBook Pro M3 Logic Board Liquid Damage Ultrasonic Repair', 'Louis Rossmann', 'Schematic boardview diagnostics, PPBUS_G3H short circuit detection under thermal camera, and SMD rework.', 'productive'),
  yt('v3yt031', 'How to Patch Drywall Holes and Skim Coat Textured Ceilings', 'Vancouver Carpenter', 'Mixing setting-type joint compound, feathering paper tape seams, and sanding without gouging.', 'productive'),
  yt('v3yt032', 'Session 14: Intrinsic Valuation — Free Cash Flow to Firm & WACC', 'Aswath Damodaran', 'NYU Stern corporate finance lecture on equity risk premiums, unlevered beta, and terminal value growth caps.', ['finance and investing', 'science and education']),
  yt('v3yt033', 'Why Covered Call ETFs Underperform in Total Return', 'Ben Felix', 'Empirical evidence on capped upside skewness, option premium taxation, and factor exposure.', ['finance and investing']),
  yt('v3yt034', 'Intermediate Spanish Comprehensible Input: History of the Inca Road System', 'Dreaming Spanish', 'Slow, clear B1 Spanish listening practice with visual drawings about Andean engineering and chasqui runners.', ['science and education']),
  yt('v3yt035', 'JLPT N2 Grammar Breakdown: ざるを得ない vs ほかない Nuances', 'Nihongo no Mori', 'Japanese grammar lesson with example sentences for formal written obligations and inevitable outcomes.', ['science and education']),
  yt('v3yt036', 'Late Bronze Age Collapse: Mycenaean Palaces and Sea Peoples Epigraphy', 'Fall of Civilizations', 'Historical documentary lecture examining Linear B tablets, Ugarit diplomatic letters, and tin trade networks.', ['science and education']),

  // --- YouTube Ambiguous / Clickbait Titles that are PRODUCTIVE via Channel+Context (12) ---
  yt('v3yt037', 'I was completely wrong about this...', 'Primeagen', 'Benchmarks comparing SQLite WAL mode vs Postgres connection pooling for high-throughput Go web servers.', ['programming and software development'], 'Clickbait title, dev channel+context'),
  yt('v3yt038', 'Never do this in production', 'Fireship', 'Why storing JWT session tokens in localStorage exposes apps to XSS and how HttpOnly SameSite cookies work.', ['programming and software development'], 'Clickbait title, security coding context'),
  yt('v3yt039', 'This broke my brain for 3 weeks', '3Blue1Brown', 'Solving the Putnam competition probability puzzle on random tetrahedra containing the center of a sphere.', ['science and education'], 'Vague title, math lecture context'),
  yt('v3yt040', 'Stop buying these!', 'Project Farm', 'Torque wrench calibration accuracy, ratcheting tooth failure load testing, and metallurgy comparison.', 'productive', 'Clickbait title, tool testing/DIY context'),
  yt('v3yt041', 'It finally happened.', 'Jeff Geerling', 'Testing open-source NVMe PCIe Gen 4 storage cluster throughput on a 4-node Raspberry Pi CM5 NAS.', ['programming and software development'], 'Vague title, homelab hardware engineering context'),
  yt('v3yt042', 'Why nobody talks about the 4% rule flaw', 'The Plain Bagel', 'Sequence of returns risk, Trinity Study bond horizons, and inflation-adjusted retirement withdrawal rates.', ['finance and investing'], 'Clickbait title, CFA retirement finance context'),
  yt('v3yt043', 'Don\'t make this mistake on your return', 'ClearValue Tax', 'CPA explains Form 1099-K reporting thresholds, Schedule C home office deductions, and quarterly estimated taxes.', 'productive', 'Vague title, CPA tax filing context'),
  yt('v3yt044', 'How a 20 cent part ruined this engine', 'South Main Auto Repair', 'Diagnosing a torn PCV valve diaphragm causing lean fuel trim codes P0171 and crankcase vacuum leaks.', 'productive', 'Clickbait title, professional auto diagnostics context'),
  yt('v3yt045', 'The hardest problem in computer science', 'Computerphile', 'Professor Mike Pound explains cache invalidation, Lamport vector clocks, and Byzantine fault tolerance.', ['programming and software development', 'science and education']),
  yt('v3yt046', 'We need to talk about Unity', 'Gamefromscratch', 'Technical breakdown of the Godot 4.3 GDExtension C++ API, Vulkan rendering pipeline, and MIT licensing for developers.', ['programming and software development']),
  yt('v3yt047', 'How I study 10 hours a day without burning out', 'Zach Highley', 'Medical resident breaks down Pomodoro intervals, active recall with Anki, and USMLE Step 1 schedule blocks.', 'productive'),
  yt('v3yt048', 'The impossible dovetail joint explained', 'Paul Sellers', 'Hand-cut woodworking joinery tutorial using a chisel, coping saw, and marking gauge in hardwood.', 'productive'),

  // --- YouTube Distraction: Gaming, Drama, Reactions, Shorts, Vlogs, Unboxings (52) ---
  yt('v3yt049', 'Shadow of the Erdtree All 10 Remembrance Bosses RL1 No Roll', 'Ongbal', 'Hitless level 1 wretch boss rush in Elden Ring DLC using parries and deflecting hardtear.', ['video games']),
  yt('v3yt050', 'I Built an Illegal Underground Base on the Hermitcraft Server', 'Grian', 'Minecraft SMP episode 24: pranking Mumbo Jumbo with a redstone trap and secret vault.', ['video games']),
  yt('v3yt051', 'Valorant Radiant Ranked But Every Kill I Swap Mouse Sensitivity', 'TenZ', 'Playing Immortal/Radiant competitive matches on Ascent with random DPI challenges.', ['video games']),
  yt('v3yt052', 'Why Hollow Knight Silksong Took 7 Years: The Full Timeline', 'mossbag', 'Lore theory, indie game development trailers, and boss gameplay analysis.', ['video games']),
  yt('v3yt053', 'Counter-Strike 2 Knife Case Opening: $10,000 Gold Streak!', 'OhnePixel', 'Opening Kilowatt and Gallery cases live on stream hoping for a Blue Gem Karambit.', ['video games', 'gambling and betting']),
  yt('v3yt054', 'Black Myth: Wukong Full Walkthrough Gameplay Part 1 (PS5 4K 60FPS)', 'theRadBrad', 'No commentary boss fights and chapter 1 full campaign playthrough.', ['video games']),
  yt('v3yt055', 'Ranked Solo Queue Is Completely Broken Right Now', 'Tyler1', 'League of Legends Challenger jungle climb rage highlights and post-game lobby chat.', ['video games']),
  yt('v3yt056', 'Every GTA 6 Leak Confirmed in Trailer 2', 'GTA Series Videos', 'Comparing Vice City map coordinates, Lucia and Jason gameplay mechanics, and vehicle physics.', ['video games']),
  yt('v3yt057', 'Speedrunners Broke Super Mario 64 With a Cosmic Ray Bit Flip', 'Summoning Salt', 'World record history of 0-star carpetless setups and parallel universe BLJ glitches.', ['video games']),
  yt('v3yt058', 'Factorio Space Age DLC: 1 Million Science Per Minute Megabase Tour', 'Nilaus', 'Touring a fully automated interplanetary logistics factory on Vulcanus and Gleba.', ['video games']),
  yt('v3yt059', 'The Cody & Noel Situation Just Got So Much Worse...', 'penguinz0', 'MoistCr1TiKaL reacts to the latest YouTuber drama, apology statements, and Twitter receipts.', ['memes and entertainment']),
  yt('v3yt060', 'Exposing the Biggest Scam Influencer on TikTok (90 Minute Documentary)', 'Coffeezilla', 'Investigating fake luxury lifestyle flexing, Discord alpha groups, and celebrity meme coin rug pulls.', ['memes and entertainment']),
  yt('v3yt061', 'Try Not To Laugh Challenge #114 (Impossible Edition)', 'Smosh Pit', 'Cast members try to make each other spit out water with absurd costumes and impressions.', ['memes and entertainment']),
  yt('v3yt062', 'Sidemen $100,000 vs $100 Europe Holiday Challenge', 'Sidemen', 'Two teams spin a wheel to see who gets a private jet villa vs a budget hostel.', ['memes and entertainment']),
  yt('v3yt063', '20 Women vs 1 Secret Billionaire: Speed Dating Edition', 'Jubilee', 'Blindfolded dating show elimination rounds and awkward cringe moments.', ['memes and entertainment']),
  yt('v3yt064', 'Gordon Ramsay Loses His Mind Over Frozen Ravioli | Kitchen Nightmares', 'Kitchen Nightmares', 'Uncensored reality TV meltdown compilation and worst restaurant inspections.', ['memes and entertainment', 'movies and tv shows']),
  yt('v3yt065', 'We Bought Every Scam Ad Product Instagram Showed Us at 3AM', 'Good Mythical Morning', 'Rhett and Link test bizarre late-night targeted ads and wish.com knockoffs.', ['memes and entertainment', 'online shopping']),
  yt('v3yt066', 'First Date Goes Horribly Wrong in 30 Seconds | Cut', 'Cut', 'Button dating game show where contestants buzz each other out mid-sentence.', ['memes and entertainment']),
  yt('v3yt067', 'Spend a Chaotic Week With Me in NYC: Apartment Hunting & Thrift Haul', 'Emma Chamberlain', 'Lifestyle vlog, iced coffee run, vintage Designer bag shopping, and late night rambling.', ['memes and entertainment', 'online shopping']),
  yt('v3yt068', 'Unboxing Every Color of the New $2,000 Ultra Smartphone + Cases', 'Unbox Therapy', 'Hands-on retail box opening, peel ASMR, and sponsor giveaway links in description.', ['online shopping', 'memes and entertainment']),
  yt('v3yt069', 'Huge Zara & Aritzia Fall Try-On Haul 2026 (Links Below!)', 'FashionByMia', 'Trying on wool trench coats, cashmere sweaters, and wide-leg trousers with LTK affiliate discount codes.', ['online shopping']),
  yt('v3yt070', 'Top 10 Amazon Prime Day Tech Deals You Actually Need Right Now', 'DealGuy', 'Discounted ANC headphones, air fryers, and lightning deals under $50 before they sell out.', ['online shopping']),
  ytShort('v3yt071', 'Bro really thought he could jump that gap 💀😭', 'DailyClips', 'Viral fail clip from TikTok #shorts #funny #memes #viral', ['memes and entertainment', 'social media and networking']),
  ytShort('v3yt072', 'Wait for the dog\'s reaction at the end 😂 #shorts', 'PetReels', 'Golden retriever steals pizza off the counter while owner isn\'t looking.', ['memes and entertainment', 'social media and networking']),
  ytShort('v3yt073', 'When the boss walks in while you\'re doing nothing #relatable #shorts', 'OfficeHumour', 'Comedy skit about pretending to type fast on Excel.', ['memes and entertainment', 'social media and networking']),
  ytShort('v3yt074', 'Insane 1v5 Ace Clutch in Overtime 🔥 #valorant #shorts', 'ValoHighlights', 'Radiant Jett knives the last player to win the map.', ['video games', 'social media and networking']),
  ytShort('v3yt075', '3 Zara perfumes that smell like $300 luxury fragrances #shopping #shorts', 'ScentTok', 'Affordable designer dupes you need in your cart today.', ['online shopping', 'social media and networking']),
  ytShort('v3yt076', 'Streamer accidentally shows his bank balance live on Twitch 💀 #shorts', 'StreamFails', 'Clip from last night\'s Just Chatting broadcast.', ['memes and entertainment', 'social media and networking']),
  ytShort('v3yt077', '$500 Blackjack hand gone wrong in 4 seconds #casino #shorts', 'VegasSlotsLive', 'Dealer pulls a 5-card 21 against double down 20.', ['gambling and betting', 'social media and networking']),
  ytShort('v3yt078', 'Celebrity couple spotted arguing at the Met Gala afterparty 👀 #gossip #shorts', 'PopTeaDaily', 'Lip reader breaks down what they said on the red carpet.', ['memes and entertainment', 'social media and networking']),

  // --- YouTube Ambiguous / Deceptive Titles that are DISTRACTIONS via Channel+Context (10) ---
  yt('v3yt079', 'I need to apologize.', 'xQc', 'Reacting to LSF drama clips, streamer ban appeals, and playing Marbles on Stream for 4 hours.', ['memes and entertainment', 'video games'], 'Serious-sounding title, streamer drama+gaming context'),
  yt('v3yt080', 'My honest thoughts on the current state of things', 'Asmongold TV', 'MMORPG patch rant, World of Warcraft mount farming, and reacting to gaming Twitter drama.', ['video games', 'memes and entertainment'], 'Vague title, gaming drama context'),
  yt('v3yt081', 'Day 1 of my new routine', 'Logan Paul', 'Flying to Puerto Rico on a private jet, WWE backstage vlog, and Prime hydration stunts.', ['memes and entertainment']),
  yt('v3yt082', 'How I Turned $100 Into $50,000 in 20 Minutes (Live Proof)', 'SlotKingz', 'Playing high-volatility Gates of Olympus bonus buys on Stake crypto casino.', ['gambling and betting'], 'Finance-sounding title, crypto slot gambling context'),
  yt('v3yt083', 'The math behind winning every weekend', 'ParlayPrince', 'My 7-leg NFL Sunday same-game parlay locks and DraftKings sportsbook promo code.', ['gambling and betting'], 'Educational-sounding title, sportsbook betting context'),
  yt('v3yt084', 'Full lecture: Mastering wave management and tempo', 'Skill Capped Challenger LoL Guides', 'How to freeze minions in top lane, dive under turret, and win solo queue in League of Legends.', ['video games'], 'Academic-sounding title, video game guide context'),
  yt('v3yt085', 'Economy & Supply Chain Breakdown: Patch 3.25 Currency Strategy', 'Zizaran', 'Path of Exile divine orb farming atlas tree guide and scarab market flipping.', ['video games'], 'Economics-sounding title, ARPG video game context'),
  yt('v3yt086', 'Everything I bought this month (no regrets)', 'LifestyleWithChloe', 'Sephora VIB sale haul, Lululemon leggings try-on, and unboxing new Dyson hair tools.', ['online shopping']),
  yt('v3yt087', 'Why everyone is switching to this new setup in 2026', 'Boardzy', 'Reviewing 12 Artisan gaming mousepads and ultralight wireless esports mice for Apex Legends.', ['video games', 'online shopping']),
  yt('v3yt088', 'Unfiltered Q&A: answering the questions you were afraid to ask', 'CallHerDaddyClips', 'Celebrity dating rumors, toxic ex stories, and chaotic nightlife confessions.', ['memes and entertainment']),

  // --- YouTube Music, Sports, Movies, News (12) ---
  yt('v3yt089', 'Fred again.. | Boiler Room: London Live Set', 'Boiler Room', '70-minute live electronic DJ set and unreleased IDs in London.', ['music']),
  yt('v3yt090', 'Radiohead - In Rainbows From the Basement (Full Session)', 'Radiohead', 'Live studio performance of Weird Fishes/Arpeggi, Reckoner, and Nude.', ['music']),
  yt('v3yt091', 'How Daft Punk Sampled 70s Disco Records on Discovery', 'Tracklib', 'Sample breakdown showing pitch-shifting, sidechain compression, and micro-chopping.', ['music']),
  yt('v3yt092', 'Real Madrid vs Manchester City 3-3 | Champions League Quarterfinal Highlights', 'CBS Sports Golazo', 'All goals and extended match highlights from the Santiago Bernabéu.', ['sports']),
  yt('v3yt093', 'How Nikola Jokic Manipulates NBA Help Defense | Film Session', 'Thinking Basketball', 'Tactical breakdown of Denver Nuggets two-man game, short roll passing, and post splits.', ['sports']),
  yt('v3yt094', 'Max Verstappen\'s Wet Weather Lap at Interlagos Onboard Telemetry', 'Formula 1', 'Comparing braking points, differential settings, and rain line grip in Brazil.', ['sports']),
  yt('v3yt095', 'Dune: Part Two — How Denis Villeneuve Shot the Sandworm Ride', 'Vanity Fair', 'Cinematographer Greig Fraser explains IMAX 65mm lenses, infrared photography, and practical dust effects.', ['movies and tv shows']),
  yt('v3yt096', 'Severance Season 2 Official Trailer | Apple TV+', 'Apple TV', 'Return to Lumon Industries in the new sci-fi thriller series trailer.', ['movies and tv shows']),
  yt('v3yt097', 'Why Federal Reserve Quantitative Tightening Is Slowing Down', 'Wall Street Journal', 'Explaining overnight reverse repo facilities, bank reserve balances, and Treasury auctions.', ['finance and investing', 'news and politics']),
  yt('v3yt098', 'Senate Judiciary Hearing on Antitrust Enforcement in Healthcare', 'PBS NewsHour', 'Live full-length C-SPAN/PBS coverage of witness testimony and committee questioning.', ['news and politics']),
  yt('v3yt099', 'How Taiwan\'s TSMC Built the 2nm EUV Semiconductor Monopoly', 'Asianometry', 'Deep dive into extreme ultraviolet lithography, CoWoS packaging, and foundry yields.', ['science and education', 'programming and software development']),
  yt('v3yt100', 'Binging with Babish: Ratatouille Confit Byaldi from Pixar', 'Babish Culinary Universe', 'Step-by-step French vegetable Tian recipe, piperade sauce, and knife skills.', 'productive'),

  // ══════════════════════════════════════════════════════════════════════════
  // COHORT 2: Reddit Productive vs. Distraction (90 cases)
  // Tests /r/<subreddit>/comments/... across technical, academic, utility,
  // gaming, meme, gossip, and gambling communities.
  // ══════════════════════════════════════════════════════════════════════════

  // --- Reddit Productive: Engineering, Science, Finance/Taxes, DIY, Academia (45) ---
  reddit('rust', '1a01/pin_projection_soundness_in_self_referential_futures', 'Understanding Pin<&mut Self> soundness when writing custom async state machines', 'When implementing Future manually without pin-project, how do you guarantee structural pinning doesn\'t violate drop guarantees?', ['programming and software development']),
  reddit('rust', '1a02/migrating_our_tokio_ingestion_service_cut_p99', 'Migrating our Kafka ingestion worker to Rust + io_uring cut p99 latency by 70%', 'Architecture writeup: replacing jemalloc with thread-local slab buffers and zero-copy capnproto parsing.', ['programming and software development']),
  reddit('ExperiencedDevs', '1a03/handling_schema_migrations_on_4tb_postgres_tables', 'How does your team handle zero-downtime column migrations on 4TB+ Postgres tables?', 'We use expand-and-contract with triggers and batched backfills, but pg_repack lock contention is biting us during peak traffic.', ['programming and software development']),
  reddit('ExperiencedDevs', '1a04/staff_engineer_promotion_packet_technical_strategy', 'Writing a Staff Engineer RFC that aligns three orgs on a unified event bus', 'Looking for advice on structuring architecture decision records (ADRs) and running design review meetings without bike-shedding.', 'productive'),
  reddit('linuxquestions', '1a05/systemd_networkd_wireguard_split_tunnel_dns_leak', 'Fixing systemd-resolved DNS leak over WireGuard split-tunnel VPN on Debian 12', 'Setting Domains=~corp.internal in the .network unit still forwards public queries to the default gateway interface.', ['programming and software development']),
  reddit('linuxquestions', '1a06/zfs_ashift_12_vs_13_on_enterprise_nvme_mirror', 'ZFS pool ashift=12 vs ashift=13 and recordsize tuning for PostgreSQL KVM guests', 'Benchmarks using fio randrw with sync=always on Samsung PM9A3 drives with PLP.', ['programming and software development']),
  reddit('homelab', '1a07/proxmox_ceph_cluster_on_10gbe_sfp_mikrotik_switch', 'My 3-node Proxmox VE + Ceph HA homelab cluster build and power consumption breakdown', 'Configured VLAN trunking on a MikroTik CRS309 switch, UPS NUT graceful shutdown scripts, and PBS incremental backups.', ['programming and software development']),
  reddit('homelab', '1a08/opnsense_vlan_firewall_rules_for_iot_segmentation', 'OPNsense firewall rules and mDNS repeater setup for isolating IoT VLANs', 'Documenting my RFC1918 alias blocks, Unbound DNS local overrides, and Suricata IDS tuning.', ['programming and software development']),
  reddit('askscience', '1a09/why_do_neutrinos_oscillate_between_mass_eigenstates', 'Why do neutrino flavor eigenstates differ from their mass eigenstates in the PMNS matrix?', 'Explain how coherent quantum superpositions propagate at slightly different phase velocities over astrophysical baselines.', ['science and education']),
  reddit('askscience', '1a10/crispr_cas9_off_target_double_strand_break_repair', 'How does prime editing avoid double-stranded DNA breaks compared to standard CRISPR-Cas9?', 'Comparing nickase Cas9 fused to reverse transcriptase (pegRNA) against non-homologous end joining (NHEJ) indel rates.', ['science and education']),
  reddit('AcademicPhilosophy', '1a11/kripke_naming_and_necessity_rigid_designators_modal', 'Kripke\'s rigid designators and a posteriori necessity in modal logic S5', 'Discussion of Putnam\'s Twin Earth thought experiment and two-dimensional semantics in contemporary analytic philosophy.', ['science and education']),
  reddit('AskHistorians', '1a12/how_did_venetian_merchants_settle_bills_of_exchange', 'How did 14th-century Venetian and Genoese merchants clear international bills of exchange?', 'Primary sources on medieval double-entry bookkeeping, notary ledgers, and Champagne fair clearinghouses.', ['science and education', 'finance and investing']),
  reddit('personalfinance', '1a13/backdoor_roth_ira_pro_rata_rule_form_8606_rollover', 'How to avoid the Form 8606 pro-rata rule when rolling a Traditional IRA into a 401(k)', 'I have $42k of pre-tax rollover IRA funds and want to execute a clean backdoor Roth contribution before December 31.', 'productive'),
  reddit('personalfinance', '1a14/comparing_hdhp_hsa_vs_ppo_health_insurance_math', 'Spreadsheet comparing employer HDHP + HSA max contribution vs PPO plan for a family of 4', 'Factoring in payroll FICA tax savings on HSA contributions, out-of-pocket maximums, and pediatric prescriptions.', 'productive'),
  reddit('tax', '1a15/schedule_c_qbi_deduction_section_199a_phaseout', 'Calculating Section 199A QBI deduction and SE health insurance adjustment on Form 1040', 'Self-employed software consultant reconciling 1099-NEC income, Solo 401(k) employer profit sharing, and state PTE election.', 'productive'),
  reddit('cad', '1a16/solidworks_surface_loft_tangency_g2_curvature_comb', 'Achieving G2 curvature continuity across a 5-sided patch in SolidWorks and Rhino', 'Tips for splitting guide curves and avoiding degenerate UV singularities on injection-molded enclosures.', 'productive'),
  reddit('medicalschool', '1a17/ankihub_step_2_ck_shelf_exam_algorithm_cards', 'How I organized my UWorld incorrects and NBME clinical mastery notes for Internal Medicine shelf', 'Workflow for tagging antibiotic coverage tables, electrolyte workups, and biostatistics formulas.', 'productive'),
  reddit('learnpython', '1a18/asyncio_taskgroup_cancellation_and_connection_pools', 'Why does asyncio.TaskGroup cancel sibling tasks when one coroutine raises an exception?', 'Understanding structured concurrency in Python 3.12, ExceptionGroup handling, and aiohttp session cleanup.', ['programming and software development']),
  reddit('cpp', '1a19/std_expected_monadic_operations_and_constexpr_in_cpp23', 'Benchmarking std::expected vs exceptions in low-latency C++23 order book parsing', 'Disassembly comparison in Compiler Explorer (Godbolt) showing zero-overhead happy paths when error types fit in registers.', ['programming and software development']),
  reddit('Embedded', '1a20/stm32_dma_circular_buffer_uart_idle_line_interrupt', 'Zero-CPU UART reception on STM32H7 using DMA circular mode and IDLE line interrupts', 'Handling cache coherency (SCB_InvalidateDCache_by_Addr) when DMA writes to AXI SRAM.', ['programming and software development']),
  reddit('Database', '1a21/duckdb_parquet_predicate_pushdown_and_zonemap_pruning', 'How DuckDB uses Parquet row-group min/max statistics for vectorized predicate pushdown', 'Querying 200GB of S3 Hive-partitioned Parquet logs on a single laptop without spinning up Spark.', ['programming and software development']),
  reddit('MachineLearning', '1a22/d_paper_direct_preference_optimization_kl_divergence', '[R] Analyzing gradient entanglement in Direct Preference Optimization (DPO) vs PPO RLHF', 'Empirical study on length bias, log-probability margin collapse, and reference model KL regularization.', ['science and education', 'programming and software development']),
  reddit('Physics', '1a23/deriving_bardeen_cooper_schrieffer_bcs_gap_equation', 'Deriving the BCS superconducting energy gap equation via Bogoliubov quasiparticle transformation', 'Condensed matter graduate homework question on phonon-mediated Cooper pair binding energy.', ['science and education']),
  reddit('chemistry', '1a24/interpreting_13c_dept_135_and_hsqc_2d_nmr_spectra', 'Help assigning quaternary carbons in this 13C DEPT-135 and 1H-13C HSQC NMR spectrum', 'Synthesizing a substituted indole derivative; the aromatic region shows overlapping doublet-of-doublets.', ['science and education']),
  reddit('HomeImprovement', '1a25/wiring_a_20a_gfci_afci_dual_function_breaker_in_subpanel', 'NEC code requirements for neutral-ground bonding when wiring a detached garage subpanel', 'Installing a 60A feeder with 4-wire SER cable, isolated neutral bar, and two ground rods.', 'productive'),
  reddit('MechanicAdvice', '1a26/2018_honda_accord_p0302_cylinder_2_misfire_compression', '2018 Honda Accord 1.5T P0302 misfire on cold start — boroscope shows coolant on piston crown', 'Performed a block combustion leak test and cooling system pressure test; head gasket failure between cyl 2 and 3.', 'productive'),
  reddit('woodworking', '1a27/flattening_a_warped_white_oak_workbench_top_with_hand_planes', 'Flattening a twisted 3-inch white oak Roubo workbench slab using winding sticks and a #7 jointer plane', 'Step-by-step layout marks, traversing across the grain with a jack plane, and checking coplanarity.', 'productive'),
  reddit('EngineeringStudents', '1a28/mohrs_circle_3d_principal_stresses_and_von_mises_yield', 'Mechanics of Materials: Drawing Mohr\'s Circle for plane stress and checking Von Mises yield criterion', 'Worked solution for a pressurized thin-walled cylindrical vessel under combined axial tension and torsion.', ['science and education']),
  reddit('cscareerquestions', '1a29/negotiating_rsus_and_signing_bonus_for_senior_swe_offer', 'Evaluating total compensation, RSU vesting cliffs, and refresher grants across two Senior Backend offers', 'Comparing base salary, 1-year cliff vs quarterly vesting, and engineering team on-call load.', 'productive'),
  reddit('aws', '1a30/iam_role_trust_policy_oidc_github_actions_least_privilege', 'Hardening AWS IAM OIDC trust policies for GitHub Actions deployments with condition keys', 'Restricting sts:AssumeRoleWithWebIdentity by repo, branch environment claim, and permission boundaries.', ['programming and software development']),
  reddit('kubernetes', '1a31/cilium_ebpf_kube_proxy_replacement_and_bgp_peering', 'Migrating a bare-metal K8s cluster from Calico IPIP to Cilium eBPF kube-proxy replacement with BGP', 'Throughput and CPU softirq improvements under 50k RPS Envoy ingress load.', ['programming and software development']),
  reddit('DataEngineering', '1a32/apache_iceberg_compaction_and_hidden_partitioning_at_scale', 'Tuning Apache Iceberg small-file compaction and sort-order clustering on Trino', 'Reducing S3 LIST API costs and metadata manifest bloat on streaming CDC tables.', ['programming and software development']),
  reddit('PLC', '1a33/allen_bradley_studio_5000_pid_loop_tuning_for_vfd_pump', 'Commissioning a cascade PID pressure control loop in Studio 5000 over EtherNet/IP', 'Scaling 4-20mA pressure transducer inputs and configuring deadband to prevent valve hunting.', 'productive'),
  reddit('FPGA', '1a34/crossing_clock_domains_with_gray_code_async_fifo_in_verilog', 'Synthesizing a parameterizable Dual-Clock Asynchronous FIFO in SystemVerilog with Vivado timing constraints', 'Setting set_max_delay -datapath_only on Gray-coded read/write pointer synchronizer flip-flops.', ['programming and software development']),
  reddit('LaTeX', '1a35/tikz_commutative_diagrams_and_biblatex_biber_custom_citation', 'Aligning TikZ-cd exact sequences and customizing biblatex-chicago footnote citations for a thesis', 'Fixing overfull hbox warnings in multi-line aligned equations.', 'productive'),
  reddit('ObsidianMD', '1a36/zettelkasten_atomic_notes_and_dataview_queries_for_phd', 'How I structure my PhD literature review using BibTeX citations and DataviewJS tables', 'Keeping permanent notes linked by concept without drowning in folder hierarchies.', 'productive'),
  reddit('Anki', '1a37/fsrs_v5_desired_retention_and_optimizing_parameters', 'Understanding the FSRS-5 memory scheduling algorithm: stability, retrievability, and RMSE', 'Comparing workload per day at 90% vs 85% desired retention before board exams.', 'productive'),
  reddit('Accounting', '1a38/asc_606_multi_element_saas_revenue_recognition_workpaper', 'ASC 606 revenue recognition allocation for a bundled on-prem license + PCS support contract', 'Determining standalone selling prices (SSP) and deferred revenue schedules for the Q3 audit.', 'productive'),
  reddit('Economics', '1a39/nber_working_paper_on_monetary_policy_transmission_lags', 'NBER Working Paper: Heterogeneous household balance sheets and the transmission of interest rate shocks', 'Empirical micro-data analysis of adjustable-rate vs fixed-rate mortgage refinancing channels.', ['finance and investing', 'science and education']),
  reddit('bogleheads', '1a40/three_fund_portfolio_tax_efficient_fund_placement_guide', 'Tax-efficient asset location: placing TIPS and REITs in tax-deferred accounts vs VXUS in taxable', 'Calculating foreign tax credit (Form 1116) vs municipal bond tax-equivalent yield.', ['finance and investing']),
  reddit('LegalAdvice', '1a41/commercial_lease_estoppel_certificate_and_cam_reconciliation', 'Reviewing commercial Triple Net (NNN) lease CAM reconciliation audit rights before signing', 'Landlord included roof capital expenditures in annual operating expense pass-throughs.', 'productive'),
  reddit('statistics', '1a42/hierarchical_bayesian_mixed_effects_model_in_stan_brms', 'Diagnosing divergent transitions in a hierarchical Bayesian logistic regression in Stan (cmdstanr)', 'Reparameterizing centered random slopes into a non-centered Cholesky factor parameterization.', ['science and education']),
  reddit('gis', '1a43/postgis_st_subdivide_spatial_index_for_100m_parcel_polygons', 'Speeding up PostGIS point-in-polygon joins across 100M US parcel geometries using ST_Subdivide and GiST', 'Query plan dropped from 4 hours to 90 seconds after splitting complex multipolygons to 256 vertices.', ['programming and software development']),
  reddit('Bioinformatics', '1a44/snakemake_pipeline_for_scrna_seq_seurat_harmony_integration', 'Reproducible Snakemake + Apptainer workflow for 10x Genomics scRNA-seq ambient RNA removal and doublet filtering', 'Comparing SoupX and CellBender before running Harmony batch correction across 40 patient samples.', ['science and education', 'programming and software development']),
  reddit('french', '1a45/subjonctif_present_vs_indicatif_apres_les_verbes_dopinion', 'When does "croire que" or "penser que" trigger the subjunctive in negative and interrogative clauses?', 'Grammar explanation with examples from Le Monde editorials and DELF B2 writing prompts.', ['science and education']),

  // --- Reddit Distraction: Memes, Gaming, Streamer Drama, Gossip, WSB, Shopping (45) ---
  reddit('memes', '1b01/me_pretending_to_look_at_my_phone_in_an_elevator', 'Me pretending to read an urgent text in the elevator so I don\'t have to make eye contact', '28.4k upvotes · 412 comments · Posted in r/memes. Dank memes and relatable humor.', ['memes and entertainment', 'social media and networking']),
  reddit('shitposting', '1b02/lobotomy_brainrot_meme_dump_at_3am', 'Certified 3AM brainrot dump 💀 don\'t ask what the dog is doing', 'r/shitposting — unhinged internet humor, cursed images, and ironic memes.', ['memes and entertainment', 'social media and networking']),
  reddit('me_irl', '1b03/me_irl_when_the_alarm_goes_off_in_6_minutes', 'me_irl when I check the clock and have 14 minutes of sleep left before work', 'Selfies of the soul. Relatable everyday memes and funny screenshots.', ['memes and entertainment', 'social media and networking']),
  reddit('facepalm', '1b04/influencer_complains_that_airline_wont_upgrade_her_for_exposure', 'Influencer demands free first-class seat in exchange for tagging the airline to her 12k followers', '45k upvotes · Screenshots of viral social media cringe and public fails.', ['memes and entertainment', 'social media and networking']),
  reddit('PublicFreakout', '1b05/karen_blocks_drive_thru_lane_over_expired_coupon', 'Customer refuses to move car in drive-thru for 20 minutes over an expired $1.50 smoothie coupon', 'Video clip of wild public arguments and freakouts.', ['memes and entertainment', 'social media and networking']),
  reddit('AmItheAsshole', '1b06/aita_for_uninviting_my_sister_in_law_after_she_wore_white', 'AITA for kicking my brother\'s girlfriend out of our wedding photos after she showed up in a bridal gown?', '19k upvotes · 6,400 comments · Relationship drama and family feud stories.', ['social media and networking', 'memes and entertainment']),
  reddit('BestofRedditorUpdates', '1b07/bor_final_update_my_roommate_has_been_secretly_renting_my_room', '[Final Update] My roommate was listing my bedroom on Airbnb every weekend I visited my parents', 'Binge-worthy Reddit drama compilations and relationship saga updates.', ['social media and networking', 'memes and entertainment']),
  reddit('Fauxmoi', '1b08/blind_item_which_a_list_actor_walked_off_the_press_tour', ' Deuxmoi blind item: which A-list co-stars refuse to be in the same room during the Venice press tour?', 'Pop culture gossip, celebrity tea, red carpet fashion, and Hollywood rumors.', ['memes and entertainment', 'social media and networking']),
  reddit('PopCultureChat', '1b09/every_chaotic_moment_from_last_nights_vmas_afterparty', 'Megathread: Every chaotic red carpet look and backstage feud from last night\'s award show', 'Celebrity news, entertainment gossip, and viral pop culture moments.', ['memes and entertainment', 'social media and networking']),
  reddit('LivestreamFail', '1b10/streamer_rage_quits_and_smashes_keyboard_after_losing_hardcore', 'Streamer loses 200-hour Hardcore World of Warcraft character to an elevator boss and breaks headset', 'Twitch clip highlights, streamer drama, and funny gaming livestream moments.', ['memes and entertainment', 'video games', 'social media and networking']),
  reddit('LivestreamFail', '1b11/kai_cenat_and_speed_accidentally_flood_the_streaming_room', 'Kai Cenat and IShowSpeed indoor firework stunt sets off the mansion sprinkler system live on stream', 'Viral Twitch/YouTube livestream clips and internet celebrity chaos.', ['memes and entertainment', 'social media and networking']),
  reddit('gaming', '1b12/my_wife_baked_a_skyrim_sweetroll_for_my_birthday', 'After 12 years of playing Skyrim, I still discover new unmarked quests in Blackreach', 'r/gaming — video game screenshots, memes, nostalgia, and gaming discussions.', ['video games', 'social media and networking']),
  reddit('pcgaming', '1b13/steam_summer_sale_megathread_best_deep_discounts_under_10', 'Steam Summer Sale Megathread: Best RPGs, roguelikes, and co-op games under $10 right now', 'PC video game deals, hardware benchmarks, and new game release news.', ['video games', 'online shopping']),
  reddit('eldenring', '1b14/messmer_the_impaler_phase_2_hitbox_frame_data_and_build', 'Finally soloed Messmer with dual bleed curved swords after 94 attempts — here is my level 150 build', 'Elden Ring boss strategies, weapon scaling, talismans, and lore discussions.', ['video games']),
  reddit('BaldurGate3', '1b15/honour_mode_act_3_raphael_house_of_hope_barrelmancy', 'My Honour Mode run almost ended in the House of Hope until Gale landed a 4% Hold Monster', 'Baldur\'s Gate 3 party builds, companion romances, and D&D CRPG gameplay.', ['video games']),
  reddit('VALORANT', '1b16/clove_and_jett_nerfs_in_patch_9_08_meta_tier_list', 'Post-plant smoke timings and controller tier list after the latest Valorant patch notes', 'Competitive FPS highlights, esports match threads, and agent lineups.', ['video games']),
  reddit('GlobalOffensive', '1b17/navi_vs_faze_major_final_map_3_inferno_post_match', 'Post-Match Thread: Natus Vincere vs FaZe Clan — Counter-Strike 2 Major Grand Final', 'CS2 esports tournament brackets, HLTV player ratings, and pro match highlights.', ['video games']),
  reddit('Minecraft', '1b18/i_spent_6_months_building_a_1_1_scale_cyberpunk_city_in_survival', 'I dug out a 256x256 perimeter by hand in Hardcore Survival and built a neon megacity', 'Minecraft builds, redstone contraptions, seeds, and survival worlds.', ['video games']),
  reddit('Genshin_Impact', '1b19/version_5_2_banner_four_star_characters_and_primogem_count', 'Lost my 50/50 to Qiqi at 84 pity — saving 180 wishes for the Pyro Archon rerun banner', 'Gacha game wish pulls, character artifact builds, and Spiral Abyss teams.', ['video games']),
  reddit('wallstreetbets', '1b20/yolo_140k_into_0dte_spy_calls_before_cpi_print', 'YOLO\'d my entire $140k account into 0DTE SPY 590 calls 3 minutes before the CPI print — pray for me regards', 'Degenerate options gambling, loss porn, and casino-style weekly FD bets on r/wallstreetbets.', ['gambling and betting', 'finance and investing', 'social media and networking']),
  reddit('wallstreetbets', '1b21/loss_porn_down_98_percent_on_nvda_earnings_strangle', 'Loss Porn: $85k -> $1,200 overnight on NVDA weekly puts. See you behind the Wendy\'s dumpster', 'High-risk options speculation, margin calls, and meme stock gambling.', ['gambling and betting', 'finance and investing', 'social media and networking']),
  reddit('sportsbook', '1b22/nfl_sunday_parlay_thread_hit_a_12_leg_at_plus_45000', 'NFL Sunday Degenerate Parlay Thread: Who else is tailing this +1800 anytime touchdown slip?', 'Sports betting picks, moneyline odds, player props, and sportsbook promos.', ['gambling and betting']),
  reddit('gambling', '1b23/just_hit_a_max_win_5000x_on_sweet_bonanza_at_2_dollar_bet', 'Hit the 100x bomb multiplier in the free spins bonus round on Stake ($2 spin -> $10,000 payout)', 'Casino slots, blackjack sessions, roulette, and online wagering discussions.', ['gambling and betting']),
  reddit('poker', '1b24/punted_a_300bb_pot_at_2_5_no_limit_holdem_with_top_two', 'Hand analysis: 4-bet bluffing river into the nuts at $2/$5 No-Limit Hold\'em live cash game', 'Texas Hold\'em poker cash games, WSOP bracelets, and bankroll swings.', ['gambling and betting']),
  reddit('ShoppingAddiction', '1b25/relapsed_during_ the_sephora_sale_and_hid_800_of_packages', 'Spent $800 on TikTok Shop and Sephora haul packages this week and hid the boxes from my partner', 'Impulse buying, online shopping carts, Klarna BNPL debt, and haul confessionals.', ['online shopping', 'social media and networking']),
  reddit('MakeupAddiction', '1b26/swatches_of_every_new_holiday_lip_oil_and_blush_palette', 'Swatches and review of the limited-edition holiday Vault set — currently 20% off with code GLOW', 'Cosmetics shopping hauls, beauty product releases, and store discounts.', ['online shopping']),
  reddit('Sneakers', '1b27/got_the_w_on_snkrs_draw_for_the_travis_scott_jordan_1_low', 'Finally hit on the Nike SNKRS app raffle! On-feet photos and StockX resale price check', 'Sneaker drops, streetwear retail releases, and StockX/GOAT marketplace buying.', ['online shopping']),
  reddit('buildapcsales', '1b28/gpu_rtx_4080_super_929_at_newegg_with_promo_code_zip', '[GPU] ASUS TUF RTX 4080 Super 16GB — $899 ($100 off with promo code + free game bundle at checkout)', 'PC hardware flash deals, coupon codes, and in-stock retail alerts.', ['online shopping']),
  reddit('malefashionadvice', '1b29/end_of_season_winter_coat_and_selvedge_denim_sale_list', 'Master list of end-of-season menswear sales: 40% off wool overcoats, boots, and knitwear', 'Apparel shopping guides, brand sales, and wardrobe hauls.', ['online shopping']),
  reddit('FragranceDeals', '1b30/creed_aventus_and_parfums_de_marly_tester_flash_sale', '[Deal] 35% off niche fragrance testers at Jomashop + free shipping code', 'Perfume discounts, cologne shopping deals, and flash sales.', ['online shopping']),
  reddit('television', '1b31/the_bear_season_3_official_binge_discussion_megathread', 'The Bear Season 3 — Full Season Binge Discussion & Episode Rankings Megathread', 'TV show episode recaps, streaming series discussions, and trailer reactions.', ['movies and tv shows']),
  reddit('movies', '1b32/official_discussion_nosferatu_2024_spoilers', 'Official Discussion — Robert Eggers\' Nosferatu [SPOILERS]', 'Film reviews, box office numbers, and cinema discussion threads.', ['movies and tv shows']),
  reddit('anime', '1b33/frieren_beyond_journeys_end_episode_28_finale_discussion', 'Sousou no Frieren (Frieren: Beyond Journey\'s End) — Episode 28 Finale Discussion', 'Anime episode discussions, seasonal charts, and manga adaptation reviews.', ['movies and tv shows']),
  reddit('nba', '1b34/post_game_thread_celtics_defeat_mavericks_to_win_nba_finals', '[Post Game Thread] The Boston Celtics defeat the Dallas Mavericks 106-88 to win the NBA Finals!', 'NBA box scores, highlight clips, trade rumors, and playoff game threads.', ['sports']),
  reddit('soccer', '1b35/match_thread_arsenal_vs_liverpool_premier_league', 'Match Thread: Arsenal vs Liverpool | English Premier League (2-2)', 'Football goals, VAR decisions, transfer news, and league standings.', ['sports']),
  reddit('formula1', '1b36/leclerc_wins_the_monaco_grand_prix_post_race_discussion', 'Charles Leclerc wins the Monaco Grand Prix! Post-Race Discussion & Driver Standings', 'F1 race results, qualifying lap times, and paddock news.', ['sports']),
  reddit('hiphopheads', '1b37/fresh_album_kendrick_lamar_gnx_first_impressions_thread', '[FRESH ALBUM] Kendrick Lamar — GNX (First Impressions & Tracklist Discussion)', 'New album releases, rap lyrics, production credits, and streaming links.', ['music']),
  reddit('indieheads', '1b38/top_50_albums_of_the_year_listener_poll_results', 'r/indieheads Top 50 Albums & Songs of the Year — Official Poll Results', 'Indie rock, electronic, and experimental music reviews and tour dates.', ['music']),
  reddit('nsfw', '1b39/verified_18_plus_amateur_content_megathread', '[18+ NSFW] Verified adult creator gallery and explicit video megathread', 'Warning: Over 18 only. Explicit adult photos and NSFW videos.', ['adult content']),
  reddit('gonewild', '1b40/18_plus_nsfw_verification_and_photo_album', '[F] 18+ NSFW explicit adult photo set — verification in comments', 'Adults only 18+ NSFW community.', ['adult content']),
  reddit('ContagiousLaughter', '1b41/dad_tries_vr_rollercoaster_for_the_first_time_and_panics', 'Dad tries a VR rollercoaster in the living room and grabs the TV stand for dear life 😂', 'Funny viral videos and contagious laughter clips.', ['memes and entertainment', 'social media and networking']),
  reddit('Unexpected', '1b42/wait_until_the_end_of_this_magic_trick', 'Magician asks audience member to pick a card and the reveal makes the whole room lose it', 'Viral clips with unexpected comedic twists.', ['memes and entertainment', 'social media and networking']),
  reddit('TikTokCringe', '1b43/pov_your_coworker_uses_corporate_buzzwords_at_sunday_dinner', 'POV: Your consultant brother-in-law asks to "circle back on the gravy bandwidth" at Thanksgiving', 'Best and worst viral TikTok videos, comedy skits, and internet humor.', ['memes and entertainment', 'social media and networking']),
  reddit('Damnthatsinteresting', '1b44/inside_a_2000_year_old_roman_aqueduct_still_carrying_water', 'Walking inside a 2,000-year-old Roman underground aqueduct tunnel in Nîmes', 'Interesting historical and scientific photos and videos.', ['science and education', 'memes and entertainment']),
  reddit('CasualConversation', '1b45/just_hanging_out_on_a_friday_night_what_is_everyone_up_to', 'Friday night hangout thread: what snacks are you eating and what are you procrastinating on?', 'Casual social chatting and community hangout threads.', ['social media and networking']),

  // ══════════════════════════════════════════════════════════════════════════
  // COHORT 3: X/Twitter, Substack, Medium, Discord, Twitch, Kick, TikTok, IG,
  // Threads, Bluesky (80 cases)
  // ══════════════════════════════════════════════════════════════════════════

  // --- X / Twitter: Productive Tech/Research vs Distracting Feeds/Drama/Memes (18) ---
  web('https://x.com/karpathy/status/1810001', 'Andrej Karpathy on X: "Here is a 200-line pure C implementation of GPT-2 training on CPU..."', 'X', 'Step-by-step walkthrough of backward pass gradients for LayerNorm, FlashAttention, and AdamW in llm.c.', ['programming and software development', 'science and education']),
  web('https://x.com/dan_abramov/status/1810002', 'Dan Abramov on X: "Why algebraic effects and React Suspense solve the async coloring problem"', 'X', 'Technical thread comparing coroutines, continuations, and declarative data fetching in UI trees.', ['programming and software development']),
  web('https://x.com/sama/status/1810003', 'Post / X', 'x.com', 'Video or social media feed page. Trending posts, replies, and quote tweets on your For You timeline.', ['social media and networking']),
  web('https://x.com/home', 'Following / X', 'x.com', 'Video or social media feed page. See what\'s happening in the world right now. Scroll your social timeline.', ['social media and networking']),
  web('https://x.com/i/bookmarks', 'Bookmarks / X', 'x.com', 'Saved tweets, viral meme threads, and social media posts.', ['social media and networking']),
  web('https://x.com/messages', 'Messages / X', 'x.com', 'Direct messages and group chats with your followers on X.', ['social media and networking']),
  web('https://x.com/PopBase/status/1810007', 'Pop Base on X: "BREAKING: Celebrity couple officially files for divorce after viral Coachella video 👀"', 'X', '42K Reposts · 310K Likes · Read 8,400 quote tweets and fan reactions.', ['memes and entertainment', 'social media and networking']),
  web('https://x.com/KiraTweets/status/1810008', 'kira on X: "what is the funniest screenshot on your camera roll right now? drop it below 👇😂"', 'X', 'Viral meme reply thread with 14,000 funny images and quote posts.', ['memes and entertainment', 'social media and networking']),
  web('https://x.com/FabrizioRomano/status/1810009', 'Fabrizio Romano on X: "HERE WE GO! Kylian Mbappé signs five-year contract, medical completed 🚨⚪️"', 'X', 'Football transfer news, contract details, and Champions League updates.', ['sports', 'social media and networking']),
  web('https://x.com/SecGov/status/1810010', 'U.S. SEC on X: "SEC adopts new Treasury clearinghouse margin rules and Form PF amendments"', 'X', 'Official regulatory announcement on financial market infrastructure and systemic risk.', ['finance and investing', 'news and politics']),

  // --- Substack & Medium: Productive Deep-Dives vs Culture/Gossip/Entertainment (24) ---
  web('https://newsletter.pragmaticengineer.com/p/how-stripe-builds-reliable-payment-apis', 'How Stripe Designs Idempotent Payment APIs and Ledger Systems', 'The Pragmatic Engineer', 'Distributed systems architecture deep-dive: idempotency keys, double-entry accounting ledgers, and PostgreSQL sharding.', ['programming and software development']),
  web('https://www.semianalysis.com/p/nvidia-blackwell-b200-interconnect-and-co-packaged-optics', 'NVIDIA Blackwell NVLink 72 Topology, CoWoS-L Yields, and Datacenter Power Envelopes', 'SemiAnalysis', 'Semiconductor engineering and datacenter cluster networking analysis.', ['programming and software development', 'science and education']),
  web('https://astralcodexten.substack.com/p/bayesian-meta-analysis-of-clinical-trials', 'Statistical Power and Publication Bias in Randomized Controlled Trials', 'Astral Codex Ten', 'Reviewing p-hacking, funnel plot asymmetry, and hierarchical Bayesian priors in epidemiology.', ['science and education']),
  web('https://stratechery.com/2026/tsmc-capital-expenditure-and-foundry-economics/', 'Foundry Unit Economics, Wafer Pricing, and Semiconductor Capex Cycles', 'Stratechery', 'Financial and strategic analysis of leading-edge semiconductor manufacturing.', ['finance and investing', 'programming and software development']),
  web('https://mattlevine.substack.com/p/bond-covenants-and-liability-management', 'Money Stuff: Creditor-on-Creditor Violence and Dropdowns in Leveraged Loans', 'Money Stuff', 'Corporate finance, distressed debt restructuring, and SEC indenture covenants.', ['finance and investing']),
  web('https://netflixtechblog.medium.com/optimizing-ebpf-packet-forwarding-at-400gbps-12345', 'Optimizing Linux Kernel XDP and eBPF Packet Forwarding at 400Gbps', 'Netflix TechBlog', 'How our edge appliances bypass the TCP/IP stack for video cache fill traffic.', ['programming and software development']),
  web('https://towardsdatascience.com/implementing-hnsw-approximate-nearest-neighbor-search-in-rust-9876', 'Implementing HNSW Graph Indexing for Vector Databases in Rust', 'Towards Data Science', 'Skip-list layers, greedy beam search, SIMD cosine distance kernels, and recall benchmarks.', ['programming and software development', 'science and education']),
  web('https://medium.com/@cloudflare/post-quantum-key-exchange-ml-kem-in-tls-1-3', 'Deploying ML-KEM (Kyber) Post-Quantum Cryptography Across Edge TLS Proxies', 'Cloudflare Engineering', 'Measuring hybrid X25519MLKEM768 handshake packet sizes and middlebox intolerance.', ['programming and software development']),
  web('https://hunterharris.substack.com/p/every-oscars-afterparty-dress-and-celebrity-feud', 'Hung Up: Every Met Gala Afterparty Outfit, Ex-Couple Run-In, and Blind Item', 'Hung Up on Substack', 'Celebrity gossip newsletter, pop culture commentary, and Hollywood tabloid drama.', ['memes and entertainment']),
  web('https://popculturetea.substack.com/p/the-real-housewives-reunion-meltdown-recap', 'Deep Dive Into Last Night\'s Reality TV Reunion Screaming Match & Instagram Unfollows', 'Pop Culture Tea', 'Trashy reality TV recaps, influencer breakup timelines, and celebrity drama.', ['memes and entertainment', 'social media and networking']),
  web('https://fashioncart.substack.com/p/50-things-in-my-ssense-and-net-a-porter-sale-cart', 'The Shopping Edit: 45 Designer Shoes, Bags & Knitwear Pieces on Sale Right Now', 'The Shopping Edit', 'Shop my curated luxury fashion sale links, discount promo codes, and spring wardrobe haul.', ['online shopping']),
  web('https://degenpicks.substack.com/p/my-weekend-ufc-and-nfl-parlay-betting-card', 'Sharp Action: My 5-Unit UFC Moneyline Locks and NFL Player Prop Parlays', 'Degen Picks Substack', 'Sportsbook odds, Vegas line movement, and +650 parlay betting slips.', ['gambling and betting']),

  // --- Discord, Twitch, Kick, TikTok, Instagram, Threads, Bluesky (38) ---
  web('https://discord.com/channels/912345/987654', '#general | Dank Memes & Late Night Gaming Lounge — Discord', 'Discord', 'Discord community server: hangout lounge, meme sharing, and voice chat channels for gaming.', ['social media and networking', 'video games', 'memes and entertainment']),
  web('https://discord.com/channels/112233/445566', '#valorant-lfg | Looking For Group Ranked 5-Stack — Discord', 'Discord', 'Join voice channel VC #3 to queue competitive Valorant and CS2 matches.', ['video games', 'social media and networking']),
  web('https://discord.com/channels/778899/111222', '#Compiler-Backend-WG | Rust Lang Zulip/Discord Bridge', 'Discord', 'Discussing Cranelift register allocation, LLVM 19 upgrade blockers, and MIR borrowck diagnostics.', ['programming and software development']),
  web('https://www.twitch.tv/kaicenat', 'KaiCenat - Twitch', 'Twitch', 'Live marathon subathon stream: celebrity guests, pranks, and Just Chatting with 120,000 viewers.', ['memes and entertainment', 'social media and networking']),
  web('https://www.twitch.tv/shroud', 'shroud - Twitch', 'Twitch', 'Playing competitive Deadlock and Counter-Strike 2 ranked matches live on Twitch.', ['video games']),
  web('https://www.twitch.tv/directory/category/league-of-legends', 'League of Legends - Twitch', 'Twitch', 'Watch live League of Legends esports broadcasts and Challenger solo queue streams.', ['video games']),
  web('https://www.twitch.tv/directory/category/slots', 'Slots & Virtual Casino - Twitch', 'Twitch', 'Watch high-roller crypto casino bonus buys, roulette spins, and jackpot slots live.', ['gambling and betting']),
  web('https://kick.com/trainwreckstv', 'TrainwrecksTV | Kick', 'kick.com', 'High-stakes crypto casino slots session: $1,000 spins on Wanted Dead or a Wild.', ['gambling and betting']),
  web('https://kick.com/xqc', 'xQc | Kick', 'kick.com', 'Live variety gaming stream, reacting to viral TikToks, and internet drama.', ['video games', 'memes and entertainment']),
  web('https://www.tiktok.com/@charlidamelio', 'TikTok - Make Your Day', 'TikTok', 'Video or social media feed page. Watch trending dance challenges, comedy skits, and short videos on your For You feed.', ['social media and networking', 'memes and entertainment']),
  web('https://www.tiktok.com/foryou', 'For You - TikTok', 'TikTok', 'Video or social media feed page. Scroll personalized short videos, viral audio trends, and creator reels.', ['social media and networking', 'memes and entertainment']),
  web('https://www.instagram.com/reels/', 'Reels • Instagram', 'Instagram', 'Video or social media feed page. Watch entertaining short reels, memes, and creator stories.', ['social media and networking', 'memes and entertainment']),
  web('https://www.instagram.com/explore/', 'Explore • Instagram', 'Instagram', 'Discover trending photos, fashion creators, celebrity reels, and accounts you might like.', ['social media and networking']),
  web('https://www.threads.net/', 'Threads', 'Threads', 'See what people are talking about on Threads. Reply, repost, and browse your social feed.', ['social media and networking']),
  web('https://bsky.app/', 'Bluesky', 'bsky.app', 'Social media timeline: browse Discover feed, follow friends, and post updates.', ['social media and networking']),
  web('https://www.snapchat.com/spotlight', 'Spotlight — Snapchat', 'Snapchat', 'Watch viral short-form vertical videos, pranks, and trending Snapchat stories.', ['social media and networking', 'memes and entertainment']),
  web('https://9gag.com/trending', '9GAG - Best Funny Memes and Breaking News', '9GAG', 'Scroll dank memes, funny GIFs, gaming humor, and viral comics.', ['memes and entertainment']),
  web('https://www.boredpanda.com/funny-work-memes/', '50 Hilarious Memes To Scroll Instead Of Working Today', 'Bored Panda', 'Relatable office memes, funny animal pictures, and viral internet humor.', ['memes and entertainment']),
  web('https://www.tmz.com/', 'TMZ — Celebrity News, Hollywood Gossip & Paparazzi Video', 'TMZ', 'Breaking celebrity breakups, red carpet drama, and entertainment tabloid exclusives.', ['memes and entertainment']),
  web('https://perezhilton.com/', 'Perez Hilton — Celebrity Gossip & Pop Culture News', 'Perez Hilton', 'Juicy Hollywood blind items, reality TV feuds, and influencer drama.', ['memes and entertainment']),

  // ══════════════════════════════════════════════════════════════════════════
  // COHORT 4: GitHub, Cloud Consoles & Dev Workspaces (40 cases)
  // Includes tricky counter-cases where repo/package names contain words like
  // "game", "casino", "shop", "meme", or "bet" on productive developer sites.
  // ══════════════════════════════════════════════════════════════════════════
  web('https://github.com/bevyengine/bevy/pull/14921', 'Fix pipelined rendering extract phase race condition by cart · Pull Request #14921 · bevyengine/bevy', 'GitHub', 'Pull request code review, Rust ECS schedule graph diff, and CI build status checks.', ['programming and software development', 'video games']),
  web('https://github.com/godotengine/godot/issues/92104', 'Vulkan Forward+ shadow atlas memory leak when resizing viewport · Issue #92104 · godotengine/godot', 'GitHub', 'Bug report with RenderDoc capture, C++ call stack, and reproduction project.', ['programming and software development']),
  web('https://github.com/medusajs/medusa/actions/runs/998877', 'CI / test-integration-cart-checkout · Workflow run · medusajs/medusa', 'GitHub', 'GitHub Actions CI pipeline logs for open-source headless commerce Node.js backend.', 'productive'),
  web('https://crates.io/crates/tokio', 'tokio — asynchronous runtime for the Rust programming language // Lib.rs / Crates.io', 'crates.io', 'Package registry: version 1.40.0, Cargo.toml dependencies, feature flags, and API docs link.', ['programming and software development']),
  web('https://crates.io/crates/rand_distr', 'rand_distr — random number distributions (normal, Poisson, gamma, beta) in Rust', 'crates.io', 'Rust statistical probability distribution sampling library documentation.', ['programming and software development', 'science and education']),
  web('https://docs.rs/axum/latest/axum/routing/struct.Router.html', 'Router in axum::routing - Rust Documentation', 'docs.rs', 'API reference for composing Tower HTTP middleware services and route handlers in Axum.', ['programming and software development']),
  web('https://pypi.org/project/pydantic/', 'pydantic · PyPI — Data validation using Python type hints', 'PyPI', 'Python package index: pip install pydantic, release history, and wheel downloads.', 'productive'),
  web('https://pkg.go.dev/context', 'context package - context - Go Packages', 'pkg.go.dev', 'Standard library documentation for Context deadlines, cancellation signals, and request-scoped values.', 'productive'),
  web('https://godbolt.org/z/9a8b7c', 'Compiler Explorer — C++ (x86-64 clang 18.1.0 -O3 -mavx2)', 'godbolt.org', 'Interactive assembly output comparing vectorized SIMD loops and branchless intrinsics.', ['programming and software development']),
  web('https://regex101.com/r/xYz123/1', 'regex101: build, test, and debug regular expressions (PCRE2 / ECMAScript)', 'regex101.com', 'Regular expression debugger with capture group explanation and step count.', ['programming and software development']),
  web('https://huggingface.co/BAAI/bge-small-en-v1.5', 'BAAI/bge-small-en-v1.5 · Hugging Face Model Card', 'Hugging Face', 'Sentence embedding transformer model weights, MTEB retrieval benchmarks, and ONNX usage snippet.', ['programming and software development', 'science and education']),
  web('https://console.aws.amazon.com/ec2/home?region=us-east-1#Instances:', 'Instances | EC2 Management Console — us-east-1', 'Amazon Web Services', 'Cloud console dashboard: manage virtual machines, security groups, VPC subnets, and EBS volumes.', 'productive'),
  web('https://console.cloud.google.com/kubernetes/list/overview', 'Google Kubernetes Engine (GKE) Clusters — Google Cloud Console', 'Google Cloud', 'Manage autopilot clusters, node pools, workload identity, and Cloud Logging.', 'productive'),
  web('https://dash.cloudflare.com/12345/workers-and-pages', 'Workers & Pages | Cloudflare Dashboard', 'Cloudflare', 'Deploy serverless edge workers, D1 SQLite databases, KV namespaces, and R2 buckets.', 'productive'),
  web('https://dashboard.render.com/web/srv-12345/logs', 'api-production — Logs & Metrics | Render Dashboard', 'Render', 'Live container stdout logs, CPU/memory graphs, and zero-downtime deploy history.', 'productive'),
  web('https://fly.io/dashboard/personal/machines', 'Machines · Fly.io Dashboard', 'Fly.io', 'Firecracker microVM deployment status, Anycast IPv6 allocations, and WireGuard peers.', 'productive'),
  web('https://app.datadoghq.com/apm/traces', 'APM Trace Explorer — Datadog', 'Datadog', 'Application monitoring dashboard: p99 latency flame graphs, SQL query spans, and error rates.', 'productive'),
  web('https://sentry.io/organizations/acme/issues/554433/', 'TypeError: Cannot read properties of undefined (reading \'map\') — Sentry Issue #554433', 'Sentry', 'Production stack trace, source map symbolication, and affected release telemetry.', 'productive'),
  web('https://linear.app/acme-eng/issue/ENG-402/fix-race-condition-in-webhook-worker', 'ENG-402: Fix idempotency race condition in Stripe webhook consumer — Linear', 'Linear', 'Sprint ticket queue, assignee, priority Urgent, and linked GitHub pull request.', 'productive'),
  web('https://www.overleaf.com/project/65f1a2b3c4d5e6', 'neurips_2026_camera_ready.tex — Overleaf, Online LaTeX Editor', 'Overleaf', 'Collaborative LaTeX manuscript editor, PDF preview, and bibliography references.', 'productive'),
  web('https://colab.research.google.com/drive/1abcDEF', 'fine_tune_whisper_lora.ipynb - Colaboratory', 'Google Colab', 'Jupyter notebook running PyTorch GPU training loops and evaluation metrics.', ['programming and software development', 'science and education']),
  web('https://kaggle.com/competitions/vesuvius-challenge-ink-detection/discussion', '3D U-Net + SegFormer Ensemble Solution Writeup (1st Place) | Kaggle', 'Kaggle', 'Machine learning competition architecture, cross-validation folds, and training code.', ['programming and software development', 'science and education']),
  web('https://arxiv.org/abs/2407.12345', '[2407.12345] Scaling Laws for Speculative Decoding in Small Language Models', 'arXiv.org', 'Computer Science > Computation and Language paper abstract, PDF download, and BibTeX citation.', ['science and education', 'programming and software development']),
  web('https://pubmed.ncbi.nlm.nih.gov/38912345/', 'Randomized Trial of SGLT2 Inhibitors in Chronic Kidney Disease - PubMed', 'PubMed', 'New England Journal of Medicine clinical trial abstract, hazard ratios, and MeSH terms.', 'productive'),
  web('https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream', 'ReadableStream - Web APIs | MDN', 'MDN Web Docs', 'Technical documentation for Streams API backpressure, locked readers, and async iteration.', 'productive'),

  // ══════════════════════════════════════════════════════════════════════════
  // COHORT 5: Shopping & E-Commerce vs. SaaS / Errands Counter-Cases (60 cases)
  // ══════════════════════════════════════════════════════════════════════════

  // --- Must-Block Shopping (38) ---
  web('https://www.amazon.com/dp/B0CHX1W1XY', 'Sony WH-1000XM5 Wireless Industry Leading Noise Canceling Headphones : Electronics', 'Amazon.com', 'Online store product page. $328.00. FREE Returns. In Stock. Add to Cart or Buy Now with 1-Click.', ['online shopping']),
  web('https://www.amazon.com/gp/cart/view.html', 'Amazon.com Shopping Cart', 'Amazon.com', 'Online store checkout page. Subtotal (3 items): $142.85. Proceed to checkout with Prime FREE One-Day Delivery.', ['online shopping']),
  web('https://www.amazon.com/deals', 'Today\'s Deals: New Deals Every Day - Amazon.com', 'Amazon.com', 'Shop Lightning Deals, Deal of the Day, and limited-time coupons up to 60% off.', ['online shopping']),
  web('https://www.ebay.com/itm/285910293847', 'Vintage Seiko Automatic Chronograph Watch 6139-6002 — Buy It Now or Best Offer | eBay', 'eBay', 'Online store product page. Condition: Pre-owned. Place bid or Buy It Now with eBay Money Back Guarantee.', ['online shopping']),
  web('https://www.etsy.com/listing/1648291034/solid-walnut-desk-shelf', 'Handmade Solid Walnut Monitor Stand & Desk Shelf Organizer - Etsy', 'Etsy', 'Online store product page. $135.00. Only 2 left in stock — order soon. Add to basket.', ['online shopping']),
  web('https://www.temu.com/channel/lightning-deals.html', 'Temu | Lightning Deals — Up to 90% Off Flash Sale & Free Shipping', 'Temu', 'Shop clothing, kitchen gadgets, phone cases, and home decor at wholesale prices.', ['online shopping']),
  web('https://www.aliexpress.com/item/1005006789012.html', ' CNC Aluminum Custom Mechanical Keyboard Kit 75% Gasket Mount RGB — AliExpress', 'AliExpress', 'Online store product page. US $64.50. Choice Free Shipping & 15-day delivery.', ['online shopping']),
  web('https://www.target.com/p/dyson-v15-detect-cordless-vacuum/-/A-83901234', 'Dyson V15 Detect Cordless Stick Vacuum : Target', 'Target', 'Online store product page. $649.99. Save 5% with Target Circle Card. Pick up today or ship to home.', ['online shopping']),
  web('https://www.walmart.com/ip/Ninja-CREAMi-Ice-Cream-Maker/918273645', 'Ninja CREAMi Ice Cream, Gelato & Sorbet Maker — Walmart.com', 'Walmart.com', 'Online store product page. Rollback $169.00. Add to cart for free shipping or curbside pickup.', ['online shopping']),
  web('https://www.bestbuy.com/site/lg-65-class-c4-series-oled-4k-uhd-smart-webos-tv/6578012.p', 'LG 65" Class C4 Series OLED evo 4K UHD Smart webOS TV — Best Buy', 'Best Buy', 'Online store product page. $1,499.99 (Save $500). Add to Cart. Geek Squad protection available.', ['online shopping']),
  web('https://www.newegg.com/amd-ryzen-7-9800x3d-ryzen-7-9000-series/p/N82E16819113877', 'AMD Ryzen 7 9800X3D 8-Core 16-Thread Socket AM5 Desktop Processor - Newegg.com', 'Newegg.com', 'Online store product page. $479.00. Add to cart. Combo up & save $40 on X870 motherboards.', ['online shopping']),
  web('https://www.bhphotovideo.com/c/product/1801234-REG/fujifilm_x100vi_digital_camera.html', 'Fujifilm X100VI Digital Camera (Silver) | B&H Photo Video', 'B&H Photo Video', 'Online store product page. $1,599.00. Add to Cart or Add to Wish List.', ['online shopping']),
  web('https://www.nike.com/t/air-zoom-pegasus-41-mens-road-running-shoes-extra-wide', 'Nike Pegasus 41 Men\'s Road Running Shoes. Nike.com', 'Nike.com', 'Online store product page. Select size and width. Add to Bag. Free standard shipping for Members.', ['online shopping']),
  web('https://shop.lululemon.com/p/mens-trousers/ABC-Classic-Fit-Trouser-32-Warpstreme', 'ABC Classic-Fit Trouser 32" *Warpstreme | Men\'s Pants | lululemon', 'lululemon', 'Online store product page. $128 USD. Select color and waist size. Ship it or pick up in store.', ['online shopping']),
  web('https://www.ssense.com/en-us/men/sale', 'Designer Menswear Sale: Up to 70% Off Streetwear & Luxury Fashion | SSENSE', 'SSENSE', 'Shop discounted designer jackets, sneakers, trousers, and accessories.', ['online shopping']),
  web('https://www.sephora.com/product/dior-addict-lip-glow-oil-P453814', 'Dior Addict Lip Glow Oil - Sephora', 'Sephora', 'Online store product page. $40.00. Shade: 001 Pink. Add to Basket for Beauty Insider points.', ['online shopping']),
  web('https://www.ikea.com/us/en/p/karlby-countertop-walnut-veneer-50335208/', 'KARLBY Countertop, walnut/veneer, 74x1 1/2" - IKEA', 'IKEA', 'Online store product page. $249.00. Check in-store stock or add to shopping bag for delivery.', ['online shopping']),
  web('https://www.wayfair.com/furniture/pdp/sand-stable-mid-century-leather-sofa-w005123456.html', 'Mid-Century Modern Genuine Leather Sofa — Wayfair', 'Wayfair', 'Online store product page. 42% Off Way Day Deal! Free Fast Delivery.', ['online shopping']),
  web('https://www.REI.com/product/228456/patagonia-torrentshell-3l-rain-jacket-mens', 'Patagonia Torrentshell 3L Rain Jacket - Men\'s | REI Co-op', 'REI', 'Online store product page. $179.00. Members get 10% Co-op dividend. Add to cart.', ['online shopping']),
  web('https://stockx.com/air-jordan-4-retro-military-blue-2024', 'Jordan 4 Retro Industrial Blue (2024) — Buy & Sell on StockX', 'StockX', 'Online store product page. Last Sale: $234. Buy Now or Place Bid. StockX Verified Authentic.', ['online shopping']),
  web('https://www.uniqlo.com/us/en/products/E465185-000/00', 'AIRism Cotton Oversized Crew Neck Half-Sleeve T-Shirt | UNIQLO US', 'UNIQLO', 'Online store product page. $19.90 Limited-Time Offer. Select size XS-XXL and add to cart.', ['online shopping']),
  web('https://www.costco.com/kirkland-signature-organic-extra-virgin-olive-oil-2l.product.100334.html', 'Kirkland Signature Organic Extra Virgin Olive Oil, 2 Liters | Costco', 'Costco Wholesale', 'Online store product page. 2-Day Delivery price $24.99. Add to Cart.', ['online shopping']),
  web('https://www.microcenter.com/product/674521/apple-macbook-pro-16-m3-max', 'Apple MacBook Pro 16" M3 Max 48GB RAM 1TB SSD Space Black — Micro Center', 'Micro Center', 'Online store product page. Save $350 instantly. Reserve online for 18-minute in-store pickup.', ['online shopping']),
  web('https://www.sweetwater.com/store/detail/SM7dB--shure-sm7db-active-dynamic-vocal-microphone', 'Shure SM7dB Active Dynamic Vocal Microphone with Built-in Preamp | Sweetwater', 'Sweetwater', 'Online store product page. $499.00. In Stock! Free 2-year warranty & fast shipping. Add to Cart.', ['online shopping']),

  // --- Productive Counter-Cases: SaaS Pricing, Package Tracking, Warranties, Manuals, Utilities (22) ---
  web('https://stripe.com/pricing', 'Pricing & Fees for Credit Card Processing | Stripe', 'Stripe', '2.9% + 30¢ per successful card charge for online payments. Integrated billing, invoicing, and enterprise custom volume pricing.', 'productive'),
  web('https://www.cloudflare.com/plans/', 'Our Plans | Pricing for Cloudflare Pro, Business, and Enterprise', 'Cloudflare', 'Compare CDN, DDoS mitigation, WAF rules, and Zero Trust enterprise security plans.', 'productive'),
  web('https://supabase.com/pricing', 'Pricing & Fees | Supabase Postgres Database & Auth', 'Supabase', 'Free, Pro ($25/month), Team, and Enterprise plans for managed PostgreSQL, pgvector, and Edge Functions.', 'productive'),
  web('https://tailscale.com/pricing', 'Pricing · Tailscale Mesh VPN & Zero-Config WireGuard', 'Tailscale', 'Personal free plan up to 100 devices, Plus, and Enterprise SSO ACL pricing for engineering teams.', 'productive'),
  web('https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223847', 'USPS.com® - USPS Tracking® Results', 'USPS', 'Latest Update: Your package has arrived at the regional distribution facility and is in transit to the destination.', 'productive'),
  web('https://www.ups.com/track?tracknum=1Z999AA10123456784', 'Tracking | UPS - United States', 'UPS', 'Out for Delivery Today by 7:00 PM. View proof of delivery and shipment progress.', 'productive'),
  web('https://www.fedex.com/fedextrack/?trknbr=771234567890', 'FedEx Tracking — Shipment Status & Delivery Window', 'FedEx', 'On FedEx vehicle for delivery. Manage delivery instructions or hold at location.', 'productive'),
  web('https://checkcoverage.apple.com/', 'Check Your Service and Support Coverage – Apple Support', 'Apple Support', 'Enter your device serial number to verify AppleCare+ hardware warranty status and book a Genius Bar repair.', 'productive'),
  web('https://www.ifixit.com/Guide/ThinkPad+T14+Gen+3+Battery+Replacement/154321', 'ThinkPad T14 Gen 3 Battery Replacement Repair Guide - iFixit', 'iFixit', 'Step-by-step hardware teardown manual: disabling internal battery in BIOS, Phillips #0 captive screws, and connector removal.', 'productive'),
  web('https://manuals.plus/bosch/shx878zd5n-dishwasher-manual', 'Bosch 800 Series Dishwasher SHX878ZD5N Owner\'s Manual & Error Code E24 Troubleshooting', 'Manuals+', 'Appliance user manual: drain pump filter cleaning, water hardness salt settings, and wiring diagram.', 'productive'),
  web('https://www.irs.gov/forms-pubs/about-form-1040', 'About Form 1040, U.S. Individual Income Tax Return | Internal Revenue Service', 'IRS', 'Government services page. Download Form 1040 PDF, instructions, tax tables, and Schedule 1-3 attachments.', 'productive'),
  web('https://www.canada.ca/en/revenue-agency/services/e-services/digital-services-individuals/account-individuals.html', 'My Account for Individuals — Canada Revenue Agency (CRA)', 'Canada.ca', 'Government services page. View your Notice of Assessment, TFSA and RRSP contribution room, and direct deposit.', 'productive'),
  web('https://mychart.nyulangone.org/MyChart/Authentication/Login', 'MyChart - Login Page', 'NYU Langone Health', 'Account sign-in page. Medical provider page. View test results, message your doctor, and request prescription refills.', 'productive'),
  web('https://secure.chase.com/web/auth/dashboard#/dashboard/overviewAccounts/overview/index', 'Account Summary - Chase.com', 'Chase', 'Bank or financial institution page. Account management page. Checking, credit card statement balance, and bill pay.', 'productive'),
  web('https://www.fidelity.com/customer-service/transfer-assets', 'Transfer Account or Rollover 401(k) Assets to Fidelity', 'Fidelity Investments', 'Initiate an ACATS brokerage account transfer or direct institution-to-institution retirement rollover.', 'productive'),
  web('https://www.uscis.gov/feecalculator', 'Fee Calculator | USCIS', 'USCIS', 'Government services page. Calculate exact filing fees for Form I-485, I-765, and I-130 immigration petitions.', 'productive'),

  // ══════════════════════════════════════════════════════════════════════════
  // COHORT 6: Gambling, Crypto Casinos & Prediction Markets (35 cases)
  // ══════════════════════════════════════════════════════════════════════════
  web('https://polymarket.com/event/fed-interest-rate-decision-november', 'Fed Interest Rate Cut in November? Betting Odds & Predictions | Polymarket', 'Polymarket', 'Prediction market: trade Yes/No shares on live event odds with USDC.', ['gambling and betting']),
  web('https://polymarket.com/event/champions-league-winner-2026', 'UEFA Champions League Winner Odds & Prediction Market | Polymarket', 'Polymarket', 'Live prediction market odds and order book volume for sports and world events.', ['gambling and betting']),
  web('https://kalshi.com/markets/kxpres/presidential-election-winner', 'Presidential Election Winner Event Contracts & Live Odds | Kalshi', 'Kalshi', 'Bet on regulated yes/no event contracts and political prediction markets.', ['gambling and betting']),
  web('https://sportsbook.draftkings.com/leagues/football/nfl', 'NFL Odds, Point Spreads, Moneylines & Same Game Parlays | DraftKings Sportsbook', 'DraftKings Sportsbook', 'Place live NFL bets, player touchdown props, and claim your $200 bonus bets.', ['gambling and betting']),
  web('https://sportsbook.fanduel.com/navigation/nba', 'NBA Betting Odds, Player Props & Live Parlays — FanDuel Sportsbook', 'FanDuel', 'Bet on tonight\'s NBA point spreads, over/under totals, and 3-pointer parlays.', ['gambling and betting']),
  web('https://app.prizepicks.com/', 'PrizePicks — Daily Fantasy Sports Pick\'Em: More or Less Player Projections', 'PrizePicks', 'Pick 2 to 6 player stat projections for up to 25x payout on NFL, NBA, and CS2.', ['gambling and betting']),
  web('https://underdogfantasy.com/pick-em', 'Underdog Fantasy Pick\'em & Best Ball Drafts — Win Up to 20x', 'Underdog Fantasy', 'Higher/Lower player prop pick\'em slips and daily fantasy snake drafts.', ['gambling and betting']),
  web('https://stake.com/casino/games/crash', 'Play Crash & Originals Crypto Casino Games Online | Stake.com', 'Stake.com', 'Crypto casino: wager Bitcoin and Ethereum on Crash, Plinko, Mines, and live dealer blackjack.', ['gambling and betting']),
  web('https://roobet.com/slots', 'Online Crypto Slots, Bonus Buys & Live Casino | Roobet', 'Roobet', 'Spin pragmatic play slots, Sweet Bonanza, and high-roller roulette tables.', ['gambling and betting']),
  web('https://pump.fun/board', 'pump.fun — Launch and Trade Solana Meme Coins Before Raydium Graduation', 'pump.fun', 'Ape into 100x degen Solana bonding-curve meme coins and live trenches chat.', ['gambling and betting', 'finance and investing']),
  web('https://www.pokerstars.com/poker/tournaments/sunday-million/', 'Sunday Million $1,000,000 Guaranteed Online Poker Tournament — PokerStars', 'PokerStars', 'Online Texas Hold\'em and Pot-Limit Omaha cash tables, Sit & Go\'s, and satellites.', ['gambling and betting']),
  web('https://www.caesars.com/sportsbook-and-casino', 'Caesars Sportsbook & Online Casino — Live Odds, Slots & Table Games', 'Caesars', 'Claim your $1,000 first bet welcome bonus on Caesars Sportsbook.', ['gambling and betting']),
  web('https://www.bet365.com/#/HO/', 'bet365 — Online Sports Betting, Live In-Play Odds & Casino', 'bet365', 'In-play football, tennis, and basketball betting odds with early payout offers.', ['gambling and betting']),

  // ══════════════════════════════════════════════════════════════════════════
  // COHORT 7: Music, Sports, Movies/TV, News, Finance, Adult (70 cases)
  // ══════════════════════════════════════════════════════════════════════════

  // --- Music (12) ---
  web('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy', 'Discovery — Album by Daft Punk | Spotify', 'Spotify', 'Music page. Listen to One More Time, Aerodynamic, Digital Love, and Harder, Better, Faster, Stronger.', ['music']),
  web('https://music.apple.com/us/album/blonde/1146195596', 'Blonde by Frank Ocean on Apple Music', 'Apple Music', 'Music page. Stream 17 songs including Nikes, Ivy, Pink + White, and Nights in lossless audio.', ['music']),
  web('https://boards-of-canada.bandcamp.com/album/music-has-the-right-to-children', 'Music Has The Right To Children | Boards of Canada | Warp Records', 'Bandcamp', 'Music page. Digital album stream, FLAC download, and double LP vinyl pressing on Bandcamp.', ['music']),
  web('https://genius.com/Kendrick-lamar-sing-about-me-im-dying-of-thirst-lyrics', 'Kendrick Lamar – Sing About Me, I\'m Dying of Thirst Lyrics | Genius', 'Genius', 'Official song lyrics, verse annotations, sample credits, and track meaning.', ['music']),
  web('https://soundcloud.com/four-tet/sets/live-at-alexandra-palace', 'Four Tet — Live at Alexandra Palace London (Full Concert Recording) | SoundCloud', 'SoundCloud', 'Stream electronic DJ mix and live concert audio tracks.', ['music']),
  web('https://tabs.ultimate-guitar.com/tab/radiohead/paranoid-android-chords-12345', 'PARANOID ANDROID CHORDS & TAB by Radiohead @ Ultimate-Guitar.Com', 'Ultimate Guitar', 'Acoustic and electric guitar tablature, chord diagrams, and strumming pattern.', ['music']),

  // --- Sports (12) ---
  web('https://www.espn.com/nba/boxscore/_/gameId/401585678', 'Nuggets 114-109 Lakers (Oct 24, 2026) Box Score - ESPN', 'ESPN', 'NBA box score, player points, rebounds, assists, and play-by-play shot chart.', ['sports']),
  web('https://www.premierleague.com/tables', 'Premier League Table, Form Guide & Season Standings', 'Premier League', 'Official English Premier League standings, goal difference, fixtures, and club results.', ['sports']),
  web('https://www.nytimes.com/athletic/5812345/2026/10/20/nfl-week-7-quarterback-film-breakdown/', 'NFL Week 7 Film Room: How Two-High Safety Shells Are Forcing Checkdowns', 'The Athletic', 'In-depth football journalism, All-22 coaching tape analysis, and EPA/play metrics.', ['sports']),
  web('https://www.formula1.com/en/results/2026/races/1245/austin/race-result', '2026 United States Grand Prix — Official Race Classification & Fastest Laps', 'Formula 1®', 'Circuit of the Americas race results, pit stop strategies, and constructor points.', ['sports']),
  web('https://www.ufc.com/event/ufc-315', 'UFC 315 Fight Card, Main Event Weigh-In Results & Bout Order | UFC.com', 'UFC', 'Official mixed martial arts fight card, championship bouts, and preliminary results.', ['sports']),
  web('https://www.strava.com/activities/123987456', 'Morning Threshold Tempo Run — 10.4 km at 3:58 /km · Heart Rate & Splits | Strava', 'Strava', 'GPS running workout log, elevation profile, cadence, and training load.', ['sports']),

  // --- Movies & TV Shows (12) ---
  web('https://www.netflix.com/watch/81234567', 'Arcane: League of Legends — Season 2 Episode 1 | Netflix Official Site', 'Netflix', 'Movie or TV show page. Stream full episodes of the animated series in 4K Ultra HD.', ['movies and tv shows', 'video games']),
  web('https://www.hulu.com/series/shogun-54321', 'Watch Shōgun Streaming Online | Hulu (Free Trial)', 'Hulu', 'Movie or TV show page. Stream all episodes of the FX historical drama series.', ['movies and tv shows']),
  web('https://www.disneyplus.com/movies/andor-a-star-wars-story/12345', 'Watch Andor | Full Season Episodes | Disney+', 'Disney+', 'Movie or TV show page. Stream Star Wars original series, Marvel films, and Pixar movies.', ['movies and tv shows']),
  web('https://www.crunchyroll.com/watch/G9DUE5821/chainsaw-man-episode-1', 'Chainsaw Man Episode 1 Subtitled — Watch on Crunchyroll', 'Crunchyroll', 'Watch anime episodes simulcast from Japan in 1080p HD.', ['movies and tv shows']),
  web('https://www.rottentomatoes.com/m/anora', 'Anora (2024) | Rotten Tomatoes — Critics Consensus & Tomatometer', 'Rotten Tomatoes', 'Movie reviews, Certified Fresh score, cast & crew, and showtimes.', ['movies and tv shows']),
  web('https://letterboxd.com/film/parasite-2019/', 'Parasite (2019) directed by Bong Joon-ho • Reviews, film + cast • Letterboxd', 'Letterboxd', 'Movie or TV show page. Film ratings, cast list, and community reviews.', ['movies and tv shows']),

  // --- News & Politics (12) ---
  web('https://www.reuters.com/world/europe/ecb-signals-cautious-path-rate-cuts-amid-services-inflation-2026-10-15/', 'European Central Bank cuts deposit rate by 25 bps as euro zone growth stalls | Reuters', 'Reuters', 'News article. Frankfurt dispatch on ECB monetary policy and inflation forecasts.', ['news and politics', 'finance and investing']),
  web('https://apnews.com/article/supreme-court-administrative-law-agency-rulemaking-12345', 'Supreme Court hears oral arguments in major challenge to federal agency regulations | AP News', 'Associated Press', 'News article. Constitutional law, judicial review, and Washington political coverage.', ['news and politics']),
  web('https://www.economist.com/leaders/2026/10/18/the-new-geopolitics-of-critical-minerals', 'The new geopolitics of lithium, copper and rare-earth supply chains | The Economist', 'The Economist', 'News article. International trade policy, industrial subsidies, and resource security.', ['news and politics', 'finance and investing']),
  web('https://www.propublica.org/article/hospital-billing-algorithm-prior-authorization-investigation', 'How Automated Insurance Algorithms Deny Prior Authorizations in Seconds — ProPublica', 'ProPublica', 'Investigative journalism report on healthcare regulation and patient appeals.', ['news and politics']),
  web('https://www.politico.com/news/2026/10/20/senate-appropriations-continuing-resolution-shutdown-001928', 'Senate leaders race to pass continuing resolution before Friday government funding deadline', 'POLITICO', 'Capitol Hill legislative negotiations, whip counts, and budget politics.', ['news and politics']),
  web('https://www.ft.com/content/a1b2c3d4-sovereign-debt-auctions', 'G7 sovereign bond yields climb ahead of heavy Treasury auction calendar | Financial Times', 'Financial Times', 'Global markets, fiscal deficits, and central bank bond coverage.', ['finance and investing', 'news and politics']),

  // --- Finance & Investing (10) ---
  web('https://www.sec.gov/ix?doc=/Archives/edgar/data/320193/000032019326000095/aapl-20260928.htm', 'Form 10-K Annual Report Pursuant to Section 13 or 15(d) — SEC EDGAR', 'SEC.gov', 'Consolidated financial statements, balance sheet, cash flows, and risk factors filing.', ['finance and investing']),
  web('https://www.tradingview.com/chart/?symbol=NASDAQ%3AQQQ', 'QQQ ETF Interactive Stock Chart, RSI & Volume Profile — TradingView', 'TradingView', 'Candlestick technical analysis, moving averages, and macro economic calendar.', ['finance and investing']),
  web('https://www.morningstar.com/etfs/arcx/vti/portfolio', 'VTI – Vanguard Total Stock Market ETF Portfolio Holdings & Expense Ratio | Morningstar', 'Morningstar', 'Fund analysis, Sharpe ratio, P/E valuation multiples, and sector weightings.', ['finance and investing']),
  web('https://seekingalpha.com/article/4729103-asml-q3-earnings-backlog-and-high-na-euv-orders', 'ASML Q3 Earnings Analysis: Net Bookings, Gross Margin Guidance, and 2027 WFE Outlook', 'Seeking Alpha', 'Equity research report, DCF model assumptions, and earnings call transcript.', ['finance and investing']),

  // --- Adult Content (12) ---
  web('https://www.pornhub.com/view_video.php?viewkey=66aabbcc', '4K Explicit Adult Tube Video — Free Porn Streaming | Pornhub', 'Pornhub', 'Watch free hardcore XXX adult videos and verified pornstar scenes.', ['adult content']),
  web('https://www.xvideos.com/tags/amateur-nsfw', 'Free Amateur XXX Porn Videos & 18+ Adult Clips — XVIDEOS.COM', 'XVideos', 'Explicit adult video category listing page. Must be 18+ to view.', ['adult content']),
  web('https://chaturbate.com/female-cams/', 'Free 18+ Cam Broadcasts & Interactive Adult Rooms — Chaturbate', 'Chaturbate', 'Watch live adult cam models and private 18+ chat rooms.', ['adult content']),
  web('https://www.literotica.com/c/erotic-couples', 'Erotic Couples Adult Fiction & NSFW Sex Stories — Literotica.com', 'Literotica', '18+ uncensored erotic stories archive and adult romance chapters.', ['adult content']),
  web('https://nhentai.net/g/491827/', '[Uncensored 18+] Adult Doujinshi & Hentai Manga Gallery — nhentai', 'nhentai', 'Explicit 18+ NSFW anime and hentai manga reader.', ['adult content']),
  web('https://fansly.com/explore', 'Fansly — Subscribe to Exclusive 18+ Adult Creators & NSFW Content', 'Fansly', 'Support adult content creators, unlock private NSFW photos, and live streams.', ['adult content']),

  // ══════════════════════════════════════════════════════════════════════════
  // COHORT 8: Short Titles (< 5 chars) (30 cases)
  // Previously dropped by `cleanTitle` (`t.length < 5`), causing live bypasses!
  // ══════════════════════════════════════════════════════════════════════════
  web('https://x.com/', 'X', 'x.com', 'Video or social media feed page. What\'s happening / For You timeline and trending posts.', ['social media and networking'], '1-char title'),
  web('https://www.ebay.com/', 'eBay', 'ebay.com', 'Online store product page. Buy and sell electronics, cars, fashion apparel, and collectibles on eBay.', ['online shopping'], '4-char title'),
  web('https://www.etsy.com/', 'Etsy', 'etsy.com', 'Shop for handmade, vintage, custom, and unique gifts for everyone on Etsy marketplace.', ['online shopping'], '4-char title'),
  web('https://www.temu.com/', 'Temu', 'temu.com', 'Shop the latest fashion, home decor, and electronics deals at low prices with free shipping.', ['online shopping'], '4-char title'),
  web('https://www.hulu.com/', 'Hulu', 'hulu.com', 'Movie or TV show page. Stream TV episodes, hit movies, and Hulu Originals online.', ['movies and tv shows'], '4-char title'),
  web('https://kick.com/', 'Kick', 'kick.com', 'Watch live gaming streams, Just Chatting creators, and high-stakes casino slots broadcasts.', ['video games', 'memes and entertainment'], '4-char title'),
  web('https://www.espn.com/', 'ESPN', 'espn.com', 'Live sports scores, NFL, NBA, MLB, and college football highlights and standings.', ['sports'], '4-char title'),
  web('https://www.imdb.com/', 'IMDb', 'imdb.com', 'Movie or TV show page. Ratings, reviews, trailers, and where to watch the best movies and TV shows.', ['movies and tv shows'], '4-char title'),
  web('https://www.ign.com/', 'IGN', 'ign.com', 'Video game reviews, walkthroughs, PS5/Xbox/PC gaming news, and movie trailers.', ['video games', 'movies and tv shows'], '3-char title'),
  web('https://www.bbc.com/news', 'BBC', 'bbc.com', 'News article. Breaking international news, UK politics, and world affairs from the BBC.', ['news and politics'], '3-char title'),
  web('https://www.cnn.com/', 'CNN', 'cnn.com', 'Breaking news, latest US politics, world headlines, and live video coverage.', ['news and politics'], '3-char title'),
  web('https://www.nba.com/', 'NBA', 'nba.com', 'Official home of the National Basketball Association: live games, box scores, and playoff standings.', ['sports'], '3-char title'),
  web('https://www.nfl.com/', 'NFL', 'nfl.com', 'Official National Football League scores, schedules, draft tracker, and game highlights.', ['sports'], '3-char title'),
  web('https://www.nhl.com/', 'NHL', 'nhl.com', 'Official National Hockey League scores, Stanley Cup playoff brackets, and highlights.', ['sports'], '3-char title'),
  web('https://www.max.com/', 'Max', 'max.com', 'Movie or TV show page. Stream HBO series, blockbuster movies, and Max Originals.', ['movies and tv shows'], '3-char title'),
  web('https://www.shein.com/', 'SHEIN', 'shein.com', 'Online store product page. Women\'s fashion clothing, dresses, shoes, and flash sale coupon codes.', ['online shopping'], '5-char border'),
  web('https://www.jd.com/', '京东', 'jd.com', 'Online store product page. Shop electronics, smartphones, appliances, and fast delivery on JD.com.', ['online shopping'], '2-char CJK title'),
  web('https://www.bilibili.com/', '哔哩哔哩', 'bilibili.com', 'Watch anime, gaming playthroughs, VTuber streams, and viral meme videos.', ['memes and entertainment', 'video games'], '4-char CJK title'),
  web('https://vk.com/feed', 'VK', 'vk.com', 'Video or social media feed page. Connect with friends, read your news feed, and send messages.', ['social media and networking'], '2-char title'),
  web('https://aws.amazon.com/console/', 'AWS', 'aws.amazon.com', 'Cloud console dashboard: manage EC2 instances, S3 buckets, IAM roles, and RDS databases.', 'productive', '3-char productive title'),
  web('https://www.nih.gov/', 'NIH', 'nih.gov', 'Government services page. National Institutes of Health biomedical research grants and clinical trials.', 'productive', '3-char title'),
  web('https://www.irs.gov/', 'IRS', 'irs.gov', 'Government services page. File federal income taxes, check refund status, and download tax forms.', 'productive', '3-char productive title'),
  web('https://web.mit.edu/', 'MIT', 'mit.edu', 'University or school page. Massachusetts Institute of Technology academic departments, research, and admissions.', 'productive', '3-char title'),
  web('https://www.edx.org/', 'edX', 'edx.org', 'University online courses in computer science, data science, and engineering.', 'productive', '3-char title'),
  web('https://ziglang.org/documentation/master/', 'Zig', 'ziglang.org', 'Language documentation: standard library modules, comptime semantics, and build system reference.', 'productive', '3-char dev docs title'),

  // ══════════════════════════════════════════════════════════════════════════
  // COHORT 9: Empty-Title Pages (`title: ""`) (25 cases)
  // Tests the new fallback ladder (`urlFallbackTitle` + `applyUrlSignals` +
  // DOM `channel`/`context`) when `document.title` is completely blank!
  // ══════════════════════════════════════════════════════════════════════════
  web('https://www.amazon.com/gp/buy/spc/handlers/display.html', '', 'Amazon.com', 'Online store checkout page. Review your order, shipping address, and payment method.', ['online shopping'], 'Empty title -> URL+context checkout'),
  web('https://www.nike.com/cart', '', 'Nike.com', 'Online store checkout page. Your shopping bag: Air Max sneakers ($140). Proceed to checkout.', ['online shopping'], 'Empty title -> /cart path hint'),
  web('https://www.zara.com/us/en/woman-new-in-l1180.html', '', 'ZARA', 'Online store product page. New collection online: shop women\'s coats, dresses, and knitwear.', ['online shopping'], 'Empty title -> slug + product hint'),
  web('https://store.steampowered.com/app/1245620/ELDEN_RING/', '', 'Steam', 'Video game page. Buy ELDEN RING on Steam. Action RPG developed by FromSoftware.', ['video games', 'online shopping'], 'Empty title -> URL slug ELDEN RING'),
  web('https://www.twitch.tv/directory/all', '', 'Twitch', 'Watch live video game streams, esports tournaments, and Just Chatting broadcasts on Twitch.', ['video games', 'social media and networking'], 'Empty title -> Twitch live streams'),
  web('https://www.tiktok.com/reels', '', 'TikTok', 'Video or social media feed page. Scroll trending short videos and creator reels.', ['social media and networking', 'memes and entertainment'], 'Empty title -> /reels path hint'),
  web('https://www.instagram.com/direct/inbox/', '', 'Instagram', 'Direct messages, story replies, and social media chat inbox.', ['social media and networking'], 'Empty title -> social inbox'),
  web('https://x.com/i/flow/login', '', 'x.com', 'Account sign-in page. Enter your username and password to sign in.', 'productive', 'Empty title sign-in must NEVER block'),
  web('https://sportsbook.draftkings.com/featured', '', 'DraftKings', 'Online sportsbook: bet on live NFL and NBA moneyline odds, parlays, and player props.', ['gambling and betting'], 'Empty title -> sportsbook'),
  web('https://stake.com/casino/home', '', 'Stake', 'Crypto casino: play slots, live blackjack, roulette, and Crash with instant crypto payouts.', ['gambling and betting'], 'Empty title -> casino'),
  web('https://www.pornhub.com/recommended', '', 'Pornhub', 'Explicit adult video streaming site. 18+ NSFW hardcore porn videos.', ['adult content'], 'Empty title -> adult'),
  web('https://9gag.com/funny', '', '9GAG', 'Dank memes, funny viral videos, and internet humor compilation.', ['memes and entertainment'], 'Empty title -> memes'),
  web('https://docs.python.org/3/library/asyncio-task.html', '', 'docs.python.org', 'Language documentation: coroutines, Tasks, asyncio.gather, and structured concurrency TaskGroups.', 'productive', 'Empty title -> Python docs slug'),
  web('https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/', '', 'kubernetes.io', 'Container orchestration documentation: Pod phase, readiness probes, and container restart policies.', 'productive', 'Empty title -> K8s slug'),
  web('https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/', '', 'MIT OpenCourseWare', 'University or school page. Gilbert Strang Linear Algebra video lectures, eigenvalues, and problem sets.', 'productive', 'Empty title -> MIT OCW slug'),
  web('https://online.citi.com/US/ag/login', '', 'Citibank', 'Account sign-in page. Bank or financial institution page. Sign on to view checking and credit card statements.', 'productive', 'Empty title bank login'),
  web('https://portal.ustraveldocs.com/account/billing', '', 'ustraveldocs.com', 'Account management page. Visa appointment scheduling and fee payment receipt.', 'productive', 'Empty title /account/billing'),
  web('https://grafana.internal.example.org/d/node-exporter-full', '', 'Grafana', 'Application monitoring dashboard: CPU utilization, memory pressure, and disk I/O metrics.', 'productive', 'Empty title monitoring dashboard'),
  web('https://jenkins.internal.example.org/job/backend-deploy-prod/412/console', '', 'Jenkins', 'CI pipeline build console output, unit test results, and Docker image push.', 'productive', 'Empty title CI build'),
  web('https://arxiv.org/pdf/2305.18290', '', 'arxiv.org', 'Research paper abstract and citations: Direct Preference Optimization: Your Language Model is Secretly a Reward Model.', ['science and education', 'programming and software development'], 'Empty title PDF URL'),
];

dataset.cases = [...baseCases, ...v3Cases];
writeFileSync(DATASET_URL, JSON.stringify(dataset, null, 2) + '\n');
console.log(`Added ${v3Cases.length} v3 cases. Total dataset size: ${dataset.cases.length} cases.`);
