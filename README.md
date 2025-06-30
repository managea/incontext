# Code Reference Extension

A VS Code extension that provides easy code reference capabilities for your workspace. This extension allows you to create and navigate code references seamlessly, making it easier to reference specific code snippets and files in documentation, comments, AI prompts, or anywhere else in your project. When working with AI tools, these precise code references help you get more accurate responses by providing exact context about the code you're discussing.

## Features

- **Copy Code References**: Easily create references to specific code selections with line numbers
- **Copy File References**: Create references to entire files 
- **Copy Directory References**: Create references to directories and folders
- **Clickable References**: References in any file are automatically highlighted and clickable for navigation
- **Smart Navigation**: Ctrl+Click on any reference to navigate directly to the referenced code or select directories in Explorer
- **Workspace Awareness**: References include project names and relative paths for multi-folder workspaces

## How It Works

### Creating References

1. **To create a code reference:**
   - Select the code you want to reference in any file
   - Press `cmd+'` (or use the context menu)
   - A reference like `@ProjectName/path/to/file.js:L10:15` will be copied to your clipboard

2. **To create a file reference:**
   - **Option 1**: Right-click on any file in the Explorer and select "Copy File Reference to Clipboard"
   - **Option 2**: Select a file in an editor and press `cmd+'`.
   - A reference like `@ProjectName/path/to/file.js` will be copied to your clipboard

3. **To create a directory reference:**
   - Right-click on any directory in the Explorer and select "Copy Directory Reference to Clipboard"
   - Or select a directory in the Explorer and press `cmd+'`
   - A reference like `@ProjectName/path/to/directory/` will be copied to your clipboard

### Using References

1. **Paste references anywhere:** In comments, documentation, markdown files, etc.
2. **Navigate to references:** 
   - **File references:** Ctrl+Click on any file reference to open the file and jump to specific lines
   - **Directory references:** Ctrl+Click on any directory reference to select and reveal that directory in the Explorer
3. **References are highlighted:** All references in your files are automatically highlighted as clickable links

### Reference Format

References follow this format:
- **Code references:** `@ProjectName/path/to/file.js:L10:15` (lines 10-15)
- **File references:** `@ProjectName/path/to/file.js` (entire file)
- **Directory references:** `@ProjectName/path/to/directory/` (directory - note the trailing slash)

## Requirements

- VS Code 1.96.0 or higher
- A workspace folder must be open for proper file path resolution

## Keyboard Shortcuts

- `cmd+'`: 
  - **With text selected**: Copy code reference from current selection to clipboard
  - **Without text selected**: Copy file reference for the current file to clipboard
  - **With directory selected in Explorer**: Copy directory reference to clipboard

## Commands

All commands are also available via the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):

- **Copy Code Reference to Clipboard**: Creates a reference to the selected code
- **Copy File Reference to Clipboard**: Creates a reference to a file
- **Copy Directory Reference to Clipboard**: Creates a reference to a directory
- **Open Reference**: Opens and navigates to a reference (used internally by clicking links)

## Context Menus

- **Editor Context Menu**: Right-click on selected code to copy a code reference
- **Explorer Context Menu**: Right-click on any file to copy a file reference, or on any directory to copy a directory reference

## Known Issues

- References only work within the same workspace
- Multi-workspace setups may require full paths for cross-workspace references
- File paths are case-sensitive on some systems

## Use Cases

This extension is particularly useful for:

- **Documentation**: Reference specific code sections in README files or documentation
- **Code Reviews**: Quickly reference specific lines of code in comments
- **Issue Tracking**: Include precise code references in bug reports
- **AI Prompts**: Create structured prompts with specific code context
- **Team Communication**: Share exact code locations with team members

## Examples

### In a Markdown file:
```markdown
The bug is in @MyProject/src/utils/parser.js:L45:50 where the validation logic fails.

See the implementation in @MyProject/src/components/UserForm.tsx for reference.

Check the test files in @MyProject/tests/unit/ for examples.
```

### In code comments:
```javascript
// TODO: Refactor this section - see @MyProject/src/legacy/oldParser.js:L100:120
// for the original implementation that needs to be updated
// All related test files are in @MyProject/tests/legacy/
```

## Troubleshooting

If you encounter issues with the extension:

1. **References not working**:
   - Ensure you have a workspace folder open
   - Check that file paths are correct and files exist
   - For directories, make sure the directory exists and the reference ends with `/`
   - Verify the reference format matches: `@ProjectName/path/to/file.js:L10:15` or `@ProjectName/path/to/directory/`

2. **Navigation issues**:
   - Make sure the referenced file exists in the workspace
   - For directory references, ensure the directory exists and is accessible
   - Check that line numbers are valid (within the file's line count)
   - Try using absolute paths if relative paths fail

3. **Clipboard issues**:
   - Check if VS Code has clipboard permissions
   - Try the command palette commands instead of keyboard shortcuts

4. **View Extension Logs**:
   - Open Developer Tools (`Ctrl+Shift+I` / `Cmd+Option+I`)
   - Check the Console tab for error messages

If problems persist, please report them on the GitHub repository.

## Release Notes

### 0.0.1

Initial release of the Code Reference Extension.

**Features:**
- Copy code references to clipboard with line numbers
- Copy file references to clipboard  
- Copy directory references to clipboard
- Automatic highlighting and navigation of references in all files
- Context menu integration for easy reference creation
- Keyboard shortcut support
- Multi-workspace aware reference formatting

---

**Enjoy creating and navigating code references!**
