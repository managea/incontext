# Changelog

## 2.1.4 (pre-release)

- **Markers:** notes become named places. <kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>N</kbd> (**InContext: Add Marker**) marks a line or the selected lines and asks for a short name, offering the line's text, which Enter keeps (Esc makes no marker): a bookmark, with a note only if you write one. Type `[[` in the name to link the new marker to one you pick, whose name then starts the new one's: `Validates the amount -> ...`. A reference pasted into the name goes into the new marker's note instead. Every link shows the marker's name, so a flow reads as what each step does
- Markers link to each other: `[[project/path#Name]]` in a note, which `[[` in a box offers by name (or as a new marker at the lines selected in another editor), and **Link to…** and **Unlink…** in the box add and take out. A reference pasted into a note that lands on a marker's lines is saved as a link to that marker. Links follow a marker as its code moves, and **Rename** renames the links too
- Above every marker's line, its name and then the links in its note, each clickable: `Validates the amount → | Persists the refund | handler.ts:L30 |`, then `+3 more`. The name opens or closes its box. A link goes to the split that already shows its marker, else opens to the right
- A link made in VS Code goes both ways: the marker you link to gets a link back at the end of its note, a link like any other. Take it out (**Unlink…**, or **Edit**) for a link that goes one way only. Links back are no longer worked out and shown on their own, and `incontext.notes.showBackLinkNotes` is gone
- No more boxes with only back-links, and no **Add note** in them: lines no marker is on, but a note refers to, show `← <name>` above them only
- Going to a marker, by a link or from the Markers view, no longer opens its box
- **Edit** comes first in a box's actions, at the left, and shows the marker's name on the first line: change it to rename the marker and every link to it. **Rename** leaves the box for **InContext: Rename Marker**. A note typed with the **+** beside a line takes its first line as the new marker's name
- `+` before the `← <name>` above lines no marker is on adds a marker there, and opens it in **Edit** with a link back to each of those markers, to name (`Input: [[...]]`) or take out. Any new marker turns the references to its lines into links to it, linked back from its note; **Edit** on a marker offers a link back for each reference into its lines, and saving turns them into links
- A note can name a reference or link its own way, `Caller: @project/src/api.ts:L30` on a line of its own, or `[[...#Name|Caller]]`: the hint above the marker and the Markers view show `Caller`, and the place or marker keeps its own name
- <kbd>Cmd</kbd>+<kbd>Enter</kbd> in a note's box saves it and closes the box, and <kbd>Esc</kbd> cancels the edit. Neither reached the box before
- A box's title shows a name with `>`, `<` or `&` as typed, not as `&gt;`
- <kbd>Esc</kbd> anywhere in the editor closes the file's open note boxes, once Esc has nothing else to do there (a selection, a suggestion, the find widget). **InContext: Close Markers in This File** does the same
- **Collections:** markers in an order of your own, such as a flow's steps, in the new **Collections** view. Drag markers in from the Markers view, or choose **Add to collection…** in a marker's box; drag steps to order them. Steps are numbered by their place, and **Name Step…** names one in that collection only (`Step one`), the marker keeping its own name. A marker can be in any number of collections. **Next Step** and **Previous Step** go through one. **Add Markers…** on a collection picks several markers at once, and the Markers view selects several with <kbd>Cmd</kbd>+click or <kbd>Shift</kbd>+click, to drag or add together (<kbd>Alt</kbd>+click now opens a marker to the side). Each collection is a Markdown file, `_collections/<name>.md` in the project's notes folder, where indented lines under a step are the collection's note on it
- Steps within a step: **Move In** and **Move Out** in the Collections view, or a list item indented under a step, for the ways a flow splits into, numbered `2.1`, `2.2` and moved with their step
- Going through a collection, each of its markers shows its place above its line, `‹ | Image upload 3/5 | ›`, to step on from the code itself. **Stop Going Through Collection** takes them away
- **Make Collection from Chain…** on a marker in the Markers view turns notes written as a chain (`Next, the upload call: [[...]]`) into a collection, the steps named as the notes named the links, and offers to take those links and their links back out of the notes: a marker's note says what is true of its code in any flow, and the order is the collection's. The AI assistant instruction now maps a flow that way
- The **Markers** view lists each file with markers, its markers by line, and under each what its note links to, one level, instead of chains
- Breaking: the notes file format. A marker is `## <name>` with `<!-- L30: <the line's text> -->` under it. Notes in the older `## L30: ...` form still show, named after their line, and are written the new way when you next change them. The AI assistant instruction writes markers and links; run **InContext: Set Up AI Assistant Instructions** again to update it
- Note boxes stay closed unless you open them. A box opened once, by you or by going to its note, came back open whenever its file was opened again, for as long as VS Code ran. Now a box you open stays open while its file has a tab, and a file opened again shows every box closed
- <kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd> (**InContext: Open or Close Notes in This File**, also in the editor's context menu) opens all of a file's note boxes, or closes them all when any is open. **Close All Notes**, the fold button in the Notes view's title bar, closes the boxes in every open file
- **Branch Changes** has an eye button that hides the comparison from your editors, the gutter bars and the ★ on tabs, without stopping it: the view still lists the changed files, and a second click shows everything again at once. Also **InContext: Toggle Branch Changes in Editors**. **Follow the Editor** is now the target button in the view's title bar

## 2.1.3 (pre-release)

- **Branch Changes** names the current branch as well as the one it is compared with: `feature vs main · merge-base`. With several repositories compared, each repository's row shows its own pair, such as `fix-login vs develop · 3 files`, and the title says how many repositories
- A file that differs from the compared branch shows a **★** in its editor tab, in the colour of its change, so you see it is part of the branch's changes the moment you open it, even when they are far down the file. The Explorer shows it too, beside git's own letter. `incontext.compare.markChangedFiles` turns it off

## 2.1.2 (pre-release)

- The Caller Tree colours each function's name and icon by its file, so rows in the same file share a colour and rows in other files stand out. Each row is now the function's name, then its file and line, dimmer (`renderArchiveGate  ReportDetails.tsx:212`), instead of `File.function`. `incontext.callerTree.colorByFile` turns the colours off
- **Fold calls within a file**, a new button in the Caller Tree's title bar, leaves out callers in the same file as the function they call and lists their own callers in their place, marked `via` the function left out: the tree shows only the steps from one file to another
- A `handler` file is named with its folder in the Caller Tree (`get-report/handler.ts`), as `index` and `route` files are
- Lines with a note of their own also show `← handler.ts:L7` above them for each note elsewhere that points at them, a click back to that note, as lines without a note do. Each sits above the line its reference starts on

## 2.1.1 (pre-release)

- A note no longer shows two or three times at its lines. It could when its file's boxes were drawn again twice at once, such as just after saving a note

## 2.1.0 (pre-release)

- Pre-releases: versions with an odd minor (2.1.x) go to the Marketplace and Open VSX as pre-releases, which only installs that choose **Switch to Pre-Release Version** get
- **Branch Changes** looks like the Explorer: each file's status letter sits at the right edge and its name takes git's colours (added, modified, deleted, renamed, untracked), with a dot on the folders above. A renamed file shows its old name beside it
- No more grey bar down the gutter of every file. It came with the **+** that adds a note beside a line, which is now off by default: add notes with **InContext: Add Note** (`Cmd+Alt+N`) or the editor's context menu, or turn the **+** back on with `incontext.notes.gutterAddButton`
- **Branch Changes** follows the editor, as the Explorer does: the file you switch to is revealed and selected in the list when it has changes. The eye button in the view's title bar turns it off, and on again

## 2.0.0

- Compare with a branch: pick a branch (**InContext: Compare with Branch…** or the status bar), and every editor's gutter marks what differs from it, uncommitted edits included, with the inline diff on a click. The **Branch Changes** view lists the changed files as a tree: a click opens the file, its diff icon the side-by-side diff. Compares from the merge-base, as a merge request does, or with the branch's tip; each repository of the window has its own branch
- The Caller Tree moves from the Explorer into the InContext sidebar, with the Notes and Branch Changes views. Until the cursor is on a function, it says what it shows
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
- The README is reframed around reading and spot-checking code that agents write, with screenshots of the InContext sidebar and Branch Changes. It was first reorganised around what InContext does now: references, opening them anywhere, notes on code, AI assistants and the Caller Tree, with screenshots of a stock VS Code that follow your light or dark mode. The changelog moves here

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
