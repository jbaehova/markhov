// Messages exchanged between the extension host and the editor webview.
// Document sync follows the @codemirror/collab model: the host is the
// authority, the webview is a client that pushes and receives updates.

export interface MarkhovConfig {
  fontSize: number;
  lineHeight: number;
  maxWidth: number;
  fontFamily: string;
  colors: 'bear' | 'vscode';
  appearance: 'auto' | 'light' | 'dark';
}

export interface WireUpdate {
  clientID: string;
  /** ChangeSet.toJSON() */
  changes: unknown;
}

export interface Resources {
  /** Webview URI of the document's folder, with a trailing slash. */
  baseUri: string | null;
  /** Webview URI of the workspace folder that contains the document, with a trailing slash. */
  workspaceUri: string | null;
}

export type HostMessage =
  | { type: 'init'; text: string; version: number; config: MarkhovConfig; resources: Resources }
  | { type: 'updates'; fromVersion: number; updates: WireUpdate[] }
  | { type: 'pushResult'; ok: boolean }
  | { type: 'reset'; text: string; version: number }
  | { type: 'config'; config: MarkhovConfig };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'push'; version: number; updates: WireUpdate[] }
  | { type: 'pull'; version: number }
  | { type: 'openLink'; href: string }
  | { type: 'error'; message: string };
