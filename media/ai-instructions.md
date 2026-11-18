## Code references

When you cite code from a workspace file in a reply, write it as a Markdown link whose label is the incontext reference itself (such as @incontext/src/extension.ts:L36:68) and whose target is an incontext link, so a click opens it in VS Code with the lines selected. Put other words, such as the symbol's name, outside the link. For workspace code, this takes precedence over other instructions about how to link to files.

If your reply is shown in a desktop app, such as the Claude desktop app, the ChatGPT/Codex app or the GitHub Copilot app, or you aren't sure where it is shown, use this target. It works wherever VS Code is running:

[@<folder>/<path>:L<start>:<end>](http://localhost:{{PORT}}/open#@<folder>/<path>:L<start>:<end>)

Only when you know your reply is shown inside VS Code or in a terminal (such as Claude Code, GitHub Copilot CLI or Codex CLI running in a terminal), use this target instead, which opens VS Code directly:

[@<folder>/<path>:L<start>:<end>]({{URI_SCHEME}}://managea.incontext/@<folder>/<path>:L<start>:<end>)

In a file you create or edit (Markdown, code comments), refer to code and to other workspace files with the reference itself as plain text, never inside a Markdown link, such as @incontext/src/extension.ts:L36:68. The incontext extension makes it clickable in VS Code. When an edit moves the lines a reference points to, update its numbers.

- <folder> is the name of the VS Code workspace folder that contains the file (usually the repository's root folder), and <path> is the file's path relative to it, with forward slashes. Percent-encode spaces as %20.
- Use :L<line> for a single line, leave out the line part to refer to a whole file, and end the path with / to refer to a folder.
- Don't put a reference or link in backticks or a code block, and only cite lines you have read.

Example in a reply: openReference is at [@incontext/src/extension.ts:L36:68](http://localhost:{{PORT}}/open#@incontext/src/extension.ts:L36:68), or inside VS Code or a terminal [@incontext/src/extension.ts:L36:68]({{URI_SCHEME}}://managea.incontext/@incontext/src/extension.ts:L36:68).

## Notes on code

The incontext extension shows markers on code in VS Code: named places on lines of a workspace file, each with an optional Markdown note, kept outside the code, linked to the markers and places they connect. Add markers only when the user asks for them, for a task or as you code, such as to map or explain a flow.

- The notes folder is {{NOTES_FOLDER}}. A project can set `incontext.notes.folder` in its own `.vscode/settings.json` to a relative folder, such as `.notes`, to keep its notes in that folder inside the project.
- The markers on a file are in `<notes folder>/<folder>/<path>.md` (or `<project>/<relative folder>/<path>.md` for a project's own folder), with <folder> and <path> as in references. If the file doesn't exist, create it with the first line `# Notes on @<folder>/<path>`.
- Each marker is a section: a heading `## <name>`, a short name for the place that is unique in the file, without `[`, `]`, `#`, `|` or `^`; on the next line `<!-- L<line>: <that line's text, trimmed> -->`, or `<!-- L<start>-L<end>: <the first line's text, trimmed> -->` for several lines; then its note in Markdown, which may be empty. Copy the line's text exactly: incontext finds the marker's lines by it when the code moves. Add your markers to a file's markers; don't change markers you didn't write.
- In a note, link to another marker by its file and name, such as `[[incontext/src/extension.ts#Registers the commands]]` (`[[#Name]]` for one in the same file), and refer to places without a marker with plain references, such as @incontext/src/extension.ts:L36:68. A link shows only on the marker whose note has it, so it goes one way unless the other marker's note links back. To name a reference or link for this note, put it on a line of its own after a label, such as `Caller: @incontext/src/extension.ts:L36`, or give a link its own text, such as `[[incontext/src/extension.ts#Registers the commands|Setup]]`. VS Code then shows that name above the marker instead, and the place or marker keeps its own name.
- A collection puts markers in an order, such as a flow's steps: `<notes folder>/<folder>/_collections/<name>.md` (`<project>/<relative folder>/_collections/<name>.md` for a project's own folder), with the first line `# <name>`, then a numbered list with a link to one marker on each item. A label before a link, such as `2. Persist: [[...]]`, names the step in that collection only, and lines indented under an item are a note on that step. An item indented four spaces under a step is a step within it, such as one of the ways a flow splits into. A marker can be in several collections; adding it to one doesn't change it.
- To map a flow, start at its entry point and follow it: one marker on each step's lines (a handler, the template that defines it, the API that calls it, the table it reads), named for what the code there does, with a note on what it does and links to the markers it calls, renders or reads directly. Then put the flow's order in a collection named for the flow: one item per step, labelled with the step's part in this flow, and where the flow splits, the ways it splits into indented under that step. A marker's note says what is true of its code in any flow; which step comes next belongs in the collection, so don't write "Next" links into notes.
