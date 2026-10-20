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
