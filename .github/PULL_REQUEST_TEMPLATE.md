## Summary (required)

<!-- One or two sentences — what does this PR do at a high level? -->

## Details (required)

<!-- Longer explanation of the change. What was the motivation? What approach did you take? Any trade-offs or decisions worth calling out? -->

## Testing (required)

Check all that apply:

- [ ] Unit tests
- [ ] Local development server
- [ ] Full deployment

**How did you test this?**

<!-- Describe what you tested and how — e.g., edge cases covered, regions tested, steps to reproduce, etc. -->

## Screenshots

<!-- Attach screenshots or screen recordings showing the change in action. -->

## ⚠️ Branch Target

> All PRs must target the **`development`** branch. PRs opened against `main` will be closed.

## Versioning

If this PR should trigger a new release, bump the `version` in `package.json`:

- **Patch** (1.0.0 → 1.0.1): Bug fixes, dependency updates, docs changes
- **Minor** (1.0.0 → 1.1.0): New features, non-breaking changes
- **Major** (1.0.0 → 2.0.0): Breaking changes (e.g., new required CloudFormation parameters)

When the version change is merged to `main`, a GitHub Release is automatically created with build artifacts. If no version bump is needed, leave it as-is — no release will be created.
