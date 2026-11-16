# Changelog

## 2.0.0

- Compare with a branch: pick a branch (**InContext: Compare with Branch…** or the status bar), and every editor's gutter marks what differs from it, uncommitted edits included, with the inline diff on a click. The **Branch Changes** view lists the changed files as a tree: a click opens the file, its diff icon the side-by-side diff. Compares from the merge-base, as a merge request does, or with the branch's tip; each repository of the window has its own branch
- The Caller Tree moves from the Explorer into the InContext sidebar, with the Notes and Branch Changes views
- A new logo, shown beside each note's name, and in the gutter beside a note whose box is closed
- Lines that only back-links point at show each back-link above them (`← handler.ts:L7`), a click back to its note, with the note on hover. Their box starts closed; open it to add a note there
- Back-links read as the note's file and line, `← handler.ts:L7`, without "Note on"
- Back-links to lines that start on the same line share one box, instead of a box for each set of lines
- Note boxes start closed, with the InContext logo in the gutter and the note on hover; a note you have just written stays open. `incontext.notes.startClosed` turns this off
- Going to a note from the InContext view or a back-link opens its box
- A rule separates a note from its box's actions
- A note's box is edged in the theme's quiet grey instead of its focus blue, and its header, the bar with its icons, is tinted to match: notes count as resolved comments, which VS Code draws more lightly
- <kbd>Cmd</kbd>+click (<kbd>Ctrl</kbd>+click on Windows and Linux) opens a row of the Caller Tree or the InContext view to the side, instead of replacing the editor you are in; a double-click keeps its tab open. In the Caller Tree, <kbd>Cmd</kbd>+<kbd>Enter</kbd> and **Open to the Side** on a row's menu do the same, and no longer pin the tree: the row's pin icon is gone, and **Pin** stays in the title bar
- The InContext view opens each note at its lines as the code is now, also after the code above it changed
- The README is reorganised around what InContext does now: references, opening them anywhere, notes on code, AI assistants and the Caller Tree, with screenshots of a stock VS Code that follow your light or dark mode. The changelog moves here

## 1.8.0

- The Caller Tree view in the Explorer: everything that reaches the function at the cursor, up to its entry points, each row labelled with its file (`ReportDetails.renderArchiveGate`). Moved here from the Agent View extension

## 1.7.0

- The InContext view, in the activity bar: every note of the open projects as chains, each note with the notes and places it points to
- A note's box shows above its lines (`incontext.notes.position`), and its references read as their file and lines, such as `handler.ts:L30`, the whole reference on hover
- Back-links show only their link, with the note on hover; `incontext.notes.showBackLinkNotes` quotes the note in the box again
- Flows read left to right: a link to the next step opens in a split to the right, and a back-link opens its note in a split to the left (made if needed), or goes back to the split that already shows it (with several, the nearest one), also within one file

## 1.6.1

- Drawings: each link opens its file in a new tab of the split beside the drawing, instead of replacing the file the last link opened

## 1.6.0

- AI assistants can write notes on code: the instruction **InContext: Set Up AI Assistant Instructions** installs tells them how, in your notes folder, such as to map a flow when you ask. Run the command again to update the instruction, and again after changing the notes folder (incontext offers to)
- Notes on code: annotate lines with Markdown notes and references, kept outside your repositories (or in a project, to commit them), shown under their lines in a box. The lines a note points to link back to it, and can get notes of their own, so a flow reads as a chain. **Move to selection** moves a note or corrects a drifted reference. See [Notes on code](README.md#notes-on-code)
- Drawings: **Copy Reference as Link (for Drawings)** copies a reference as a `vscode://` link for an Excalidraw box. A click opens the code beside the drawing, reusing one split, with no browser in between. Links from outside VS Code open beside any drawing or preview that is the active tab, rather than covering it. See [Drawings](README.md#drawings-excalidraw)
- A link-server link opened in a browser tab, such as from a drawing, brings VS Code to the front, ahead of the browser

## 1.5.0

- **InContext: Install Obsidian Plugin** installs the InContext Links plugin, which the extension now ships, into the Obsidian vaults you pick, and turns it on. Run it again after updating incontext to update the plugin. **InContext: Remove Obsidian Plugin** takes it out again

## 1.4.0

- Mermaid diagrams in the Markdown preview: a box whose `click` line links to a reference (the bare reference, or a link-server link) opens it beside the preview like any other reference, and in a new split on <kbd>Cmd</kbd>+click. Before, a click opened an unsigned link over the preview, and a double-click switched to the editor
- **InContext Links**, a companion plugin for Obsidian: references in notes and Mermaid diagrams open in VS Code with the lines selected. Install it with BRAT (`managea/incontext`) or from this release's files; see [Obsidian](README.md#obsidian)

## 1.3.1

- The AI assistant instruction covers files too: in Markdown files and code comments, AI tools write the plain reference, which incontext makes clickable, instead of a Markdown link, and keep its line numbers up to date. Run **InContext: Set Up AI Assistant Instructions** again to update what it wrote

## 1.3.0

- Links to `http://localhost:46266/open#@project/src/file.ts:L10:20` open references in VS Code from the Claude desktop app, the ChatGPT/Codex app and the GitHub Copilot app (tested on macOS). Settings: `incontext.linkServer.enabled` and `incontext.linkServer.port`
- **InContext: Set Up AI Assistant Instructions** writes one citation instruction into Claude Code, GitHub Copilot and Codex, with the link server's port, and **InContext: Remove AI Assistant Instructions** takes it out again. The README shows the same instruction
- References from AI replies (desktop apps, the terminal, `vscode://` links such as Copilot Chat's) open in the editor like any other file, instead of in a split; Markdown preview links still open beside the preview
- Security: a `vscode://managea.incontext` link that the Markdown preview didn't render (such as one on a web page) only opens files inside your workspace folders, `..` and symlinks included, and may only name a document that is open to resolve relative paths from. Links in the Markdown preview still open files outside the workspace, such as a sibling repository

## 1.2.0

- References printed in VS Code's integrated terminal (Copilot CLI, Claude Code, scripts) are clickable
- Short links, `vscode://managea.incontext/@project/src/file.ts:L10:20`, open references from GitHub Copilot Chat, Copilot CLI and anywhere else VS Code opens links; the README has a Copilot instruction for citing code this way
- In the Markdown preview, references right after `:` and other punctuation are links too

## 1.1.0

- References are clickable in the Markdown preview — bare (`@project/src/file.ts:L10:20`), in inline code, or as `[label](@project/src/file.ts#L10-L20)` — with no changes to your markdown
- Hover a reference in the Markdown preview to peek at the referenced code or folder contents
- References clicked in the preview open in a split beside it, reused by later clicks; <kbd>Cmd</kbd>+click opens another split
- Line ranges work in both styles, `:L10:20` and `#L10-L20`, and plain relative markdown links like `[label](../src/file.ts#L10-L20)` get line ranges too
- Fixed references inside markdown links picking up the closing `)`

## 1.0.1

- Added large, styled inline decoration for copy feedback (with border and padding)
- Improved keyboard shortcuts and context menu integration
- Enhanced hover previews for code and folders
- Bug fixes and polish
