# Publishing

GitHub Actions builds each tagged version and creates a GitHub Release containing the installable VSIX. Publishing to the VS Code Marketplace is performed manually by uploading that VSIX.

## One-time repository setup

No Marketplace token or repository secret is required. Open **Settings → Actions → General** and allow GitHub Actions to create releases. The release workflow requests `contents: write` explicitly.

## Create a release

Update `CHANGELOG.md` and choose the new version:

```bash
npm version patch
git push origin main --follow-tags
```

`npm version patch` updates `package.json` and `package-lock.json`, creates a version commit, and creates a matching `vX.Y.Z` tag. Pushing the tag starts `.github/workflows/release.yml`.

The release workflow:

1. Verifies that the Git tag matches the version in `package.json`.
2. Runs the dependency audit, type-check and production build.
3. Creates the VSIX package.
4. Creates a GitHub Release and attaches the VSIX.

## Publish to the VS Code Marketplace manually

1. Open the GitHub Release for the version being published.
2. Download `vscode-kuberneties-openlens-<version>.vsix`.
3. Open the Visual Studio Marketplace publisher management page.
4. Select publisher `samarin-aa-aka-rtm00`.
5. Select **New extension → Visual Studio Code** and upload the VSIX.
6. Review the extension metadata and confirm publication.

For updates, upload a VSIX with a version that has not previously been published. Marketplace versions cannot be reused after publication or deletion.

For a minor or major release, use `npm version minor` or `npm version major`.

## Retry an existing tag

Run the **Release** workflow manually from the GitHub Actions page and enter the existing tag. If the GitHub Release already exists, the workflow replaces its VSIX asset with the newly built file.