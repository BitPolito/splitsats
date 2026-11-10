# Dependency-security audit

## Recorded verification

On **2026-11-10**, on branch `dev` at commit `c43248f`, the project owner ran:

```sh
npm ci
npm audit
npm audit --omit=dev
```

Both audit commands reported **0 vulnerabilities**. `npm ci` installed 111
packages and audited 112. The production build reported Vite **6.4.5**. This is
a snapshot of that lockfile and the npm advisory database on that date; repeat
the checks against the exact release candidate before deployment.

CI runs `npm audit --omit=dev --audit-level=moderate`, so the full development
dependency tree is not currently an enforced CI gate. The full `npm audit`
above was run locally and passed for this commit.

## Release procedure

Before promoting a commit:

```sh
npm ci
npm audit
npm audit --omit=dev --audit-level=moderate
npm test
npm run test:e2e
npm run build
git diff --check
```

If an audit reports an advisory, record the package, vulnerable range,
patched version, dependency path, and whether it is included in production.
Update dependencies in a separate branch and regenerate `package-lock.json`
with npm. Do not run `npm audit fix --force` blindly or hand-edit the lockfile.

Do not commit `npm-audit.json` if it contains private registry information.
