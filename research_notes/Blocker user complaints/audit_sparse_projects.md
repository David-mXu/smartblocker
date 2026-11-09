# Validation Ledger: `sparse_projects.md`

**Validation date:** 2026-11-08  
**Scope:** Only `sparse_projects.md` and its primary citations were checked. No unrelated file was changed.

## Result

| Check | Result |
|---|---|
| Completeness | **Pass after minor repair.** Brom.ai, the LessWrong/AWF blocker, LockIn MCP, and Distraction Killer AI each retain distinct identity, status, complaint, technical-concern, and resolution/gap coverage. |
| Truncation and duplication | **Pass.** The file ends cleanly, contains one numbered identity subsection per artifact, and has no duplicated artifact sections. Repeated `Takeaway`/`Cited Findings`/`Inferences`/`Gaps` headings are intentional under the four research questions. |
| Markdown and citations | **Pass after repair.** Headings and inline-link syntax are intact. The exact Devpost URL resolves to the title “Distraction Killer AI.” |
| Evidence classification | **Pass.** Builder observations, outside-user reports, static-code findings, and theoretical third-party criticism remain separately labelled; the notes do not turn sparse feedback into prevalence claims. |

## Repairs Applied

1. **Corrected Distraction Killer’s file count** in the repository-status paragraph: “six files besides the initial README” became **“six total files.”** The pinned tree contains exactly six blobs, including README.md. — [Pinned source tree](https://github.com/AceAchyut/distraction-killer-ai/tree/0e4228babfdd068abdb3dea6e1edfe0d980a8974)
2. **Qualified the LockIn source-repository trail** in the identity paragraph and Gaps. The v1.0.20 npm README names `Kiog-Aser/LockIn`, but that GitHub URL returned HTTP 404 during validation. The note now reports only that retrieval status and explicitly avoids guessing whether the repository was renamed, made private, or removed. npm/Chrome releases remain independently supported. — [npm v1.0.20 package/README](https://www.npmjs.com/package/lockin-mcp/v/1.0.20?activeTab=readme); [named repository URL](https://github.com/Kiog-Aser/LockIn)

No other prose was rewritten, and no missing feedback or technical evidence was invented.

## Primary-Source Verification

- **Brom.ai:** The [2021-01-06 project post](https://brom.ai/posts/using-machine-learning-to-block-distractions/) and [homepage](https://www.brom.ai/) returned HTTP 200; the post explicitly says the summer-2020 experiment was discontinued.
- **AWF/LessWrong:** LessWrong’s primary metadata confirmed Sergii’s post at **2023-09-26 17:41:31 UTC**. Both cited comment permalinks returned HTTP 200. The [author’s article](https://grgv.xyz/blog/awf/) confirms the 2023-09-24 update, historical cost statement, malformed “50-10s” latency wording, privacy warning, and proposed—not completed—per-domain sampling mitigation.
- **LockIn MCP:** npm registry metadata, the v1.0.20 tarball README, the vendor privacy/terms/pricing pages, and the [exact Chrome listing](https://chromewebstore.google.com/detail/lockin-%E2%80%93-ai-distraction-b/jbfbolpcbfnljihfapplfnhimokjjkmd) corroborate the cited package date, local-relay option, privacy categories, pricing, and store metadata (0.3.7, updated 2026-08-26, 6 users, 1 rating).
- **Distraction Killer AI:** The pinned six-file tree and cited source files returned HTTP 200 and support the static-rule, focus-toggle, URL-substring, broad-permission, and no-visible-network-call findings; these remain code-derived findings rather than user incidents.
- A sweep of **44 unique primary-source URLs** produced 39 HTTP 200 responses, two rate-limited GitHub commit-history pages (429), two npm web-page anti-bot responses (403), and the now-documented LockIn repository 404. Registry data and the immutable npm tarball supplied the package evidence when npm’s web page blocked CLI retrieval.

The intentional evidence gaps remain: inaccessible Devpost narrative/comments during the original research, sparse firsthand reviews, unavailable runtime/security testing, and no inferred mapping from release counts to fixes.
