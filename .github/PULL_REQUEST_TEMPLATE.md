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

## Versioning & Releases

When changes are merged to `main`, the release workflow automatically builds and publishes a [GitHub Release](https://github.com/aws/capability-insights-for-aws/releases) with deployment artifacts (`build-assets.zip`).

- If the version in `package.json` hasn't changed, the existing release is overwritten with fresh artifacts.
- If the version is bumped, a new release is created and previous versions remain available.

Bump the `version` in `package.json` when you want to cut a new release:

- **Patch** (1.0.0 → 1.0.1): Bug fixes, dependency updates, docs changes
- **Minor** (1.0.0 → 1.1.0): New features, non-breaking changes
- **Major** (1.0.0 → 2.0.0): Breaking changes (e.g., new required CloudFormation parameters)

### Licensing

By submitting this pull request, I confirm that my contribution is made under the terms of the Apache 2.0 license.
