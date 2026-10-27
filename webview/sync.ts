import { collab, getSyncedVersion, receiveUpdates, sendableUpdates } from '@codemirror/collab';
import { ChangeSet, type Extension } from '@codemirror/state';
import { type EditorView, ViewPlugin } from '@codemirror/view';
import type { WireUpdate } from '../src/protocol';
import { post } from './host';

/** A push the host has not answered in this long means the host is gone (an extension host restart). */
const ANSWER_MS = 4000;

/** Collab client side of the document sync. The extension host is the authority. */
export class SyncClient {
  readonly clientID = Math.random().toString(36).slice(2);
  view: EditorView | null = null;
  private pushing = false;
  private pushedVersion = -1;
  private scheduled = false;
  private silence: ReturnType<typeof setTimeout> | undefined;
  private lost = false;
  /** Called when the host stops answering and again when it is back. */
  onConnection: (connected: boolean) => void = () => {};

  extension(startVersion: number): Extension {
    const client = this;
    return [
      collab({ startVersion, clientID: this.clientID }),
      ViewPlugin.define(() => ({
        update(update) {
          if (update.docChanged) client.schedulePush();
        },
      })),
    ];
  }

  receive(fromVersion: number, wire: WireUpdate[]): void {
    const view = this.view;
    if (!view) return;
    const synced = getSyncedVersion(view.state);
    if (fromVersion > synced) {
      post({ type: 'pull', version: synced });
      return;
    }
    const updates = wire
      .slice(synced - fromVersion)
      .map((u) => ({ clientID: u.clientID, changes: ChangeSet.fromJSON(u.changes) }));
    if (!updates.length) return;
    view.dispatch(receiveUpdates(view.state, updates));
    this.push();
  }

  pushResult(ok: boolean): void {
    this.pushing = false;
    const view = this.view;
    if (!view) return;
    if (ok || getSyncedVersion(view.state) > this.pushedVersion) {
      this.push();
    } else {
      // Rejected and nothing new arrived yet: ask for what we are missing.
      post({ type: 'pull', version: getSyncedVersion(view.state) });
    }
  }

  reset(): void {
    this.pushing = false;
    this.pushedVersion = -1;
  }

  /** Any message from the host shows it is still there. */
  heard(): void {
    clearTimeout(this.silence);
    this.silence = undefined;
    if (!this.lost) return;
    this.lost = false;
    this.onConnection(true);
  }

  private schedulePush(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.push();
    });
  }

  private push(): void {
    const view = this.view;
    if (!view || this.pushing) return;
    const updates = sendableUpdates(view.state);
    if (!updates.length) return;
    this.pushing = true;
    this.pushedVersion = getSyncedVersion(view.state);
    this.silence ??= setTimeout(() => {
      this.lost = true;
      this.onConnection(false);
    }, ANSWER_MS);
    post({
      type: 'push',
      version: this.pushedVersion,
      updates: updates.map((u) => ({ clientID: u.clientID, changes: u.changes.toJSON() })),
    });
  }
}
