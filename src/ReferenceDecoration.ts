import * as vscode from 'vscode';

export class ReferenceDecoration {
  public static compressedPathDecoration = vscode.window.createTextEditorDecorationType({
    opacity: '0',
    letterSpacing: '-100em',
    textDecoration: 'none',
    after: {
      contentText: '...',
      color: new vscode.ThemeColor('editorLineNumber.foreground'),
      fontStyle: 'italic'
    }
  });

  public static highlightedPathDecoration = vscode.window.createTextEditorDecorationType({
    opacity: '1.0',
    fontWeight: 'bold',
    color: new vscode.ThemeColor('textLink.foreground')
  });

  static applyPathCompressionDecorations(editor: vscode.TextEditor, REFERENCE_PATTERN: RegExp) {
    const document = editor.document;
    const compressedDecorations: vscode.DecorationOptions[] = [];
    const highlightedDecorations: vscode.DecorationOptions[] = [];
    for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex++) {
      const line = document.lineAt(lineIndex);
      const text = line.text;
      let match;
      REFERENCE_PATTERN.lastIndex = 0;
      while ((match = REFERENCE_PATTERN.exec(text)) !== null) {
        const fullReference = match[0];
        const matchStart = match.index;
        const pathPart = fullReference.substring(1);
        const pathParts = pathPart.split('/');
        if (pathParts.length > 1) {
          let currentPos = matchStart + 1;
          const projectName = pathParts[0];
          const isDirectoryReference = fullReference.endsWith('/');
          let lastSegment: string;
          if (isDirectoryReference) {
            lastSegment = pathParts.length > 2 ? pathParts[pathParts.length - 2] : pathParts[0];
          } else {
            lastSegment = pathParts[pathParts.length - 1];
          }
          highlightedDecorations.push({
            range: new vscode.Range(lineIndex, currentPos, lineIndex, currentPos + projectName.length),
            hoverMessage: `Project: ${projectName}\nFull path: ${fullReference}`
          });
          if (pathParts.length > 3) {
            currentPos += projectName.length + 1;
            let lastSegmentStart: number;
            if (isDirectoryReference) {
              const secondLastSlashIndex = fullReference.lastIndexOf('/', fullReference.length - 2);
              lastSegmentStart = matchStart + secondLastSlashIndex + 1;
            } else {
              const lastSlashIndex = fullReference.lastIndexOf('/');
              lastSegmentStart = matchStart + lastSlashIndex + 1;
            }
            if (lastSegmentStart > currentPos) {
              compressedDecorations.push({
                range: new vscode.Range(lineIndex, currentPos, lineIndex, lastSegmentStart - 1),
                hoverMessage: `Full path: ${fullReference}`
              });
            }
          }
          let lastSegmentStart: number;
          if (isDirectoryReference) {
            const secondLastSlashIndex = fullReference.lastIndexOf('/', fullReference.length - 2);
            lastSegmentStart = matchStart + secondLastSlashIndex + 1;
          } else {
            const lastSlashIndex = fullReference.lastIndexOf('/');
            lastSegmentStart = matchStart + lastSlashIndex + 1;
          }
          const segmentType = isDirectoryReference ? 'Directory' : 'File';
          highlightedDecorations.push({
            range: new vscode.Range(lineIndex, lastSegmentStart, lineIndex, lastSegmentStart + lastSegment.length),
            hoverMessage: `${segmentType}: ${lastSegment}`
          });
        }
      }
    }
    editor.setDecorations(ReferenceDecoration.compressedPathDecoration, compressedDecorations);
    editor.setDecorations(ReferenceDecoration.highlightedPathDecoration, highlightedDecorations);
  }
}
