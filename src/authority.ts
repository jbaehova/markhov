import { ChangeSet, Text } from '@codemirror/state';
import { diffToChanges } from './diff';
import type { HostMessage, WireUpdate } from './protocol';

export const HOST_CLIENT_ID = 'host';

export interface Position {
  line: number;
  character: number;
}

export interface TextEditOp {
  from: Position;
  to: Position;
  text: string;
}

/** The slice of a VS Code TextDocument the authority needs. Kept abstract so it can be tested without VS Code. */
export interface DocumentPort {
  getText(): string;
  apply(edits: TextEditOp[]): PromiseLike<boolean>;
}

/** CodeMirror counts every line break as one character, so the authority works on LF-only text. */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function textOf(text: string): Text {
  return Text.of(text.split('\n'));
}

/**
 * Central authority for one webview client. Keeps the text the client was
 * last told about, applies client pushes to the real document and turns
 * outside edits (git, formatters, the raw text editor) into updates.
 */
export class Authority {
  private doc: Text;
  private log: WireUpdate[] = [];
  private base = 0;
  private applying = false;
  private holds = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly port: DocumentPort,
    private readonly post: (message: HostMessage) => void,
  ) {
    this.doc = textOf(normalizeEol(port.getText()));
  }

  get version(): number {
    return this.base + this.log.length;
  }

  get text(): string {
    return this.doc.toString();
  }

  /** Resolves once every queued operation has finished. */
  idle(): Promise<void> {
    return this.queue;
  }

  /**
   * Resolves once the client's pushes so far are in the document, for a
   * save to wait on. It does not wait behind a hold, whose revert would
   * otherwise wait for that same save.
   */
  flushed(): Promise<void> {
    return this.holds ? Promise.resolve() : this.queue;
  }

  documentChanged(): void {
    // Our own edits are reconciled once applyEdit settles.
    if (this.applying) return;
    this.enqueue(() => this.reconcile());
  }

  push(version: number, updates: WireUpdate[]): void {
    this.enqueue(() => this.handlePush(version, updates));
  }

  pull(version: number): void {
    this.enqueue(() => this.handlePull(version));
  }

  /**
   * Runs `task` while client pushes wait, then sends the client the net
   * change. A task that rewrites the document in several steps (revert,
   * then edit) reaches the client as one update instead of a flicker.
   */
  hold(task: () => Promise<void>): Promise<void> {
    this.holds++;
    return new Promise((resolve) => {
      this.enqueue(async () => {
        this.applying = true;
        try {
          await task();
        } finally {
          this.applying = false;
          this.holds--;
          this.reconcile();
          resolve();
        }
      });
    });
  }

  private enqueue(task: () => void | Promise<void>): void {
    this.queue = this.queue.then(task).catch((error) => console.error('[markhov]', error));
  }

  private async handlePush(version: number, updates: WireUpdate[]): Promise<void> {
    this.reconcile();
    if (version !== this.version) {
      this.post({ type: 'pushResult', ok: false });
      return;
    }
    // A single client is synced up to `version`, so older entries are no longer needed.
    this.trim(version);

    let changes: ChangeSet | null = null;
    for (const update of updates) {
      const next = ChangeSet.fromJSON(update.changes);
      changes = changes ? changes.compose(next) : next;
    }
    if (!changes || changes.empty) {
      this.log.push(...updates);
      this.post({ type: 'updates', fromVersion: version, updates });
      this.post({ type: 'pushResult', ok: true });
      return;
    }
    if (changes.length !== this.doc.length) {
      this.reset();
      this.post({ type: 'pushResult', ok: false });
      return;
    }

    const edits: TextEditOp[] = [];
    changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      edits.push({ from: this.position(fromA), to: this.position(toA), text: inserted.toString() });
    });
    const next = changes.apply(this.doc);

    this.applying = true;
    let ok = false;
    try {
      ok = await this.port.apply(edits);
    } finally {
      this.applying = false;
    }
    if (!ok) {
      this.reset();
      this.post({ type: 'pushResult', ok: false });
      return;
    }

    this.doc = next;
    this.log.push(...updates);
    this.post({ type: 'updates', fromVersion: version, updates });
    this.post({ type: 'pushResult', ok: true });
    // Picks up anything that slipped in while the edit was being applied.
    this.reconcile();
  }

  private handlePull(version: number): void {
    if (version < this.base || version > this.version) {
      this.reset();
      return;
    }
    const updates = this.log.slice(version - this.base);
    if (updates.length) this.post({ type: 'updates', fromVersion: version, updates });
  }

  private reconcile(): void {
    const current = normalizeEol(this.port.getText());
    const previous = this.doc.toString();
    if (current === previous) return;
    const changes = diffToChanges(previous, current);
    const update: WireUpdate = { clientID: HOST_CLIENT_ID, changes: changes.toJSON() };
    const fromVersion = this.version;
    this.doc = changes.apply(this.doc);
    this.log.push(update);
    this.post({ type: 'updates', fromVersion, updates: [update] });
  }

  private reset(): void {
    this.doc = textOf(normalizeEol(this.port.getText()));
    this.base = this.version + 1;
    this.log = [];
    this.post({ type: 'reset', text: this.doc.toString(), version: this.version });
  }

  private trim(version: number): void {
    const count = version - this.base;
    if (count <= 0) return;
    this.log.splice(0, count);
    this.base = version;
  }

  private position(offset: number): Position {
    const line = this.doc.lineAt(offset);
    return { line: line.number - 1, character: offset - line.from };
  }
}
