# Dependency-security audit — follow-up required

On the Mac with npm registry access, capture exact advisories before changing
versions:

```bash
npm ci
npm audit --json > npm-audit.json || true
npm audit --omit=dev
npm outdated
```

Review each advisory (package, vulnerable version range, patched version,
transitive dependency and whether dev-only). Upgrade in a separate branch,
regenerate `package-lock.json` using npm, then run `npm ci`, `npm test`,
`npm run build` and browser smoke tests (Nostr signer, LNURL lookup/invoice).

Do **not** run `npm audit fix --force` blindly; it may install incompatible
major versions of Vite or other packages. Avoid editing lockfile versions by
hand. The checked-in `vite@5.4.21` belongs to an unsupported major line;
plan a tested Vite migration. Vulnerability counts change over time and depend
on the registry's advisory database. A full audit could not be performed in the
analysis environment, which cannot resolve registry.npmjs.org.

Do not commit `npm-audit.json` if it contains internal registry information.
