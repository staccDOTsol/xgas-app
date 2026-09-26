# Security

## Reporting a vulnerability

Email jarettrsdunn@gmail.com or message @STACCoverflow on X. Community reports are triaged within 2 business days and fixed under the SLA below. Please do not test against other users' funds or accounts.

## Patch SLA

The clock starts when a vulnerability is identified: a community report, a dependency advisory (`npm audit --omit=dev`), a code review finding, or an upstream security release.

| Severity | Patched or mitigated in production within |
|---|---|
| Critical (funds, keys, auth bypass, remote code execution, Plaid data exposure) | 72 hours |
| High | 7 days |
| Medium | 30 days |
| Low | 90 days, or the next release |

Severity is the advisory's rating, raised or lowered for how reachable the flaw is in our code. When no fix exists upstream, we mitigate (disable the feature, pin, patch locally, or remove the dependency) within the same window and record why.

End-of-life runtimes and base images are treated as High from their EOL date.

## Open items

| Identified | Item | Severity | Due |
|---|---|---|---|
| 2026-09-26 | 7 advisories via @privy-io/server-auth → @solana/web3.js → jayson (stream-json, uuid); the only automatic fix is a breaking Privy downgrade | Medium | 2026-10-26 |
| 2026-09-26 | Docker base image node:20 is past end of life (April 2026) | High | 2026-10-03 |
