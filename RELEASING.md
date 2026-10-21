# Releasing

Releases are published by GitHub Actions ([`.github/workflows/publish.yml`](.github/workflows/publish.yml)) when a `v*` tag is pushed. The workflow publishes to:

- **Visual Studio Marketplace** (VS Code), signed in as an Azure managed identity. No token is stored anywhere, so nothing expires.
- **Open VSX** (Cursor and other VS Code forks), with trusted publishing. No token is stored here either. This step is off until the `managea` namespace claim is approved and the trusted publisher is registered; then turn it on by setting `OPEN_VSX_ENABLED` to `true` (see the table below).
- **GitHub Releases**: once the extension is published, the `obsidian` job builds the Obsidian plugin ([`obsidian/`](obsidian/)) and attaches its `main.js`, `manifest.json` and `styles.css` to a GitHub release for the tag, creating the release if needed. BRAT and manual installs get the plugin from there. Its version is the extension's version from `package.json`.

## Release a new version

1. Update the version (no tag yet):

   ```bash
   npm version 1.2.0 --no-git-tag-version
   ```

2. Add an entry for the version under **Changelog** in `README.md`. The README is also the Marketplace page.
3. Commit, then push the commit and a tag that matches the version:

   ```bash
   git commit -am "Release 1.2.0"
   git tag v1.2.0
   git push origin main v1.2.0
   ```

4. Watch the **Publish** run under the repo's **Actions** tab. It fails early if the tag doesn't match `package.json`.
5. Check that the new version is live. The Marketplace scans each version first, which usually takes a few minutes:

   ```bash
   npx @vscode/vsce show managea.incontext
   ```

   Open VSX: <https://open-vsx.org/extension/managea/incontext>

   Obsidian plugin: the tag's release under <https://github.com/managea/incontext/releases> has `main.js`, `manifest.json` and `styles.css`.

Installed copies update on their own once the version is live. Only copies installed from the Marketplace auto-update, not ones installed from a `.vsix`. Switch a machine back with `code --install-extension managea.incontext --force`.

### If a release fails

Fix the cause, then **Re-run jobs** on the failed run. Both publish steps skip a version the store already has, so a re-run only finishes what's missing.

## Try a build locally before releasing

```bash
npx @vscode/vsce package
code --install-extension incontext-<version>.vsix --force
```

Then run **Developer: Reload Window** in VS Code. A `.vsix` install doesn't auto-update, so switch back to the Marketplace version afterwards (command above).

For the Obsidian plugin, build it into `obsidian/dist` and copy that into a vault:

```bash
npm run build:obsidian
cp obsidian/dist/* <vault>/.obsidian/plugins/incontext-links/
```

Then, in Obsidian under **Settings → Community plugins**, turn **InContext Links** off and on again to load the new build (press the refresh button next to **Installed plugins** the first time).

## How publishing is set up

| Piece | Where | What it does |
| --- | --- | --- |
| Managed identity `incontext-publisher` | Azure, resource group `incontext-publishing` | The account the workflow publishes as. It has **Reader** on its resource group. |
| Federated credential `github-incontext-marketplace` | On the managed identity | Trusts GitHub Actions jobs from this repo's `marketplace` environment, using GitHub's immutable subject (`repo:managea@<id>/incontext@<id>:environment:marketplace`). |
| Immutable subject claim | This repo: **Settings → Actions → OIDC** | Must stay **on**, or GitHub's sign-in no longer matches the federated credential. |
| GitHub environment `marketplace` | This repo: **Settings → Environments** | Holds the variables `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID`, plus `OPEN_VSX_ENABLED` (set it to `true` to publish to Open VSX). Only `main` and `v*` tags can use it. |
| Azure DevOps user | Organization `atmica` (connected to the Azure directory) | The identity is added as a **Stakeholder**, which gives it the profile the Marketplace needs. |
| Publisher member | Marketplace publisher `managea` → **Members** | The identity is a **Contributor**, so it can publish updates. |
| Trusted publisher | Open VSX namespace `managea` → **Trusted Publishers** | Trusts this repo's `publish.yml` workflow and `marketplace` environment. **Not set up yet:** it can be registered once the namespace claim ([#14455](https://github.com/EclipseFdn/open-vsx.org/issues/14455)) is approved. Then set `OPEN_VSX_ENABLED` to `true` and re-run the latest release to publish what Open VSX is missing. The workflow uses an `OVSX_PAT` secret instead, if one is set. |

To print the identity's Marketplace ID (needed to re-add it to the publisher), run the **Publish** workflow manually with **lookup-identity** ticked. That mode publishes nothing.

## Troubleshooting

| Error in the workflow log | Fix |
| --- | --- |
| `Tag vX does not match package.json version` | Tag the commit whose `package.json` has that version. |
| `AADSTS700213: No matching federated identity record` | The subject GitHub sent doesn't match the federated credential. Check that the repo's immutable subject claim is still on, and that the job uses the `marketplace` environment. |
| `VSS011031: There is no profile for the authenticated user` | The identity isn't in an Azure DevOps organization connected to the Azure directory. Add it to `atmica` as a Stakeholder. |
| Marketplace publish returns 401 or 403 | The identity isn't a member of the `managea` publisher (or lost the Contributor role). |
| `No trusted publisher matches the presented token` (Open VSX) | Register or fix the trusted publisher on the `managea` namespace. |
| Open VSX version shows as inactive or under review | The `managea` namespace must be verified. The ownership claim is [EclipseFdn/open-vsx.org#14455](https://github.com/EclipseFdn/open-vsx.org/issues/14455). |
