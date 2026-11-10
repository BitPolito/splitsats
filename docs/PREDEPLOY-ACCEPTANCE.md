# SplitSats pre-deployment acceptance

**Release rule:** do not deploy a preview or production version until every
required gate below is complete. The last verified source state is
`dev@c43248f`; repeat the checks after any later code change.

## 1. Source and automated checks

- [ ] Work from a clean checkout of the release candidate.
- [ ] Confirm the release candidate contains the reviewed `dev` history and
      that the current `master` diff has been reviewed before promotion.
- [ ] Run `npm ci`.
- [ ] Run `npm test` and `npm run test:e2e`.
- [ ] Run `npm audit` and `npm audit --omit=dev --audit-level=moderate`.
- [ ] Run `npm run build` and `git diff --check`.
- [ ] Confirm the GitHub Actions checks pass for the exact commit to be merged.
- [ ] Review the Vite chunk-size warning (the 2026-11-10 build produced a
      585 kB JavaScript chunk) and record whether it needs splitting for the
      expected users/devices.

The checks on `c43248f` passed locally: 498 unit/integration tests, 11
Playwright tests, both npm audits with zero findings, and a successful build.
Those results do not apply automatically to later commits.

## 2. Manual local acceptance

Do these on `npm run dev` before any Vercel deployment. Use two distinct
NIP-07 test identities in separate browser profiles; group and consent events
are public Nostr data, so do not use private keys, personal test data, or
production groups.

- [ ] Sign in as two different accounts and confirm account switching does not
      expose the previous account's cached groups or profile.
- [ ] Create a test group and verify both clients receive the same signed group,
      expense, and balance after synchronization and refresh.
- [ ] Exercise a pending settlement and verify the ledger changes only after
      the recipient's signed confirmation. Do not confirm a payment that was
      not actually received.
- [ ] Disconnect/reconnect a relay during publication. Confirm the outbox
      keeps the original signed event and retry does not create a duplicate.
- [ ] In 3B-I, compare exports from both clients; verify matching observations
      remain non-authorizing, and altered, stale, conflicting, or invalid
      evidence is blocked.
- [ ] Generate but do not pay a QR invoice; confirm it remains pending.
- [ ] Exercise LNURL lookup and invoice generation without sending funds.
      Confirm arbitrary `callback` parameters, private IPs, redirects, invalid
      metadata, oversized responses, and invalid invoices are rejected by the
      local implementation.

Record browser versions, wallet/signer versions, relay endpoints, test date,
and any anomalies. Never record `nsec`, seed phrases, or payment preimages.

## 3. Operational security

- [ ] Review `docs/LNURL-SECURITY.md` against the current implementation.
- [ ] Configure and verify a Vercel Firewall rate-limit rule for
      `/api/lnurl` before allowing public traffic. The application has no
      durable per-IP limiter. Make this part of the final launch cutover only
      after all code and manual gates pass.
- [ ] Confirm the Vercel project uses the reviewed repository and intended
      production branch, and that no secrets are placed in client-visible
      variables.
- [ ] Enable required CI checks / branch protection for the release branch.

## 4. Promotion and deployment

- [ ] Open and review a PR from `dev` to `master`; the current `master`
      is substantially behind, so review the complete 76-commit change set.
- [ ] Merge only after all automated, manual, and operational gates pass.
- [ ] Deploy the exact merged commit to production, then run a smoke test for
      sign-in, group loading, LNURL validation, and error handling.
- [ ] Keep real-value payment use disabled until a separate, explicit
      operational review approves it.

No Vercel preview or production deployment is part of this preparation stage.
