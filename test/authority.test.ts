import { collab, getSyncedVersion, receiveUpdates, sendableUpdates } from '@codemirror/collab';
import { ChangeSet, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { Authority, diffToChanges, type DocumentPort, type TextEditOp } from '../src/authority';
import type { HostMessage } from '../src/protocol';

/** In-memory stand-in for a VS Code TextDocument, keeping its own line endings. */
class FakeDocument implements DocumentPort {
  constructor(public text: string) {}

  getText(): string {
    return this.text;
  }

  offset(line: number, character: number): number {
    const lines = this.text.split(/(?<=\n)/);
    let offset = 0;
    for (let i = 0; i < line; i++) offset += lines[i].length;
    return offset + character;
  }

  async apply(edits: TextEditOp[]): Promise<boolean> {
    const eol = this.text.includes('\r\n') ? '\r\n' : '\n';
    const resolved = edits
      .map((e) => ({ from: this.offset(e.from.line, e.from.character), to: this.offset(e.to.line, e.to.character), text: e.text.replace(/\n/g, eol) }))
      .sort((a, b) => b.from - a.from);
    for (const e of resolved) this.text = this.text.slice(0, e.from) + e.text + this.text.slice(e.to);
    return true;
  }
}

/** Collab client driven by plain EditorState, mirroring webview/sync.ts. */
class Client {
  state: EditorState;
  pushing = false;
  constructor(text: string, version: number) {
    this.state = EditorState.create({ doc: text, extensions: [collab({ startVersion: version, clientID: 'web' })] });
  }

  edit(from: number, to: number, insert: string): void {
    this.state = this.state.update({ changes: { from, to, insert } }).state;
  }

  push(authority: Authority): void {
    const updates = sendableUpdates(this.state);
    if (this.pushing || !updates.length) return;
    this.pushing = true;
    authority.push(
      getSyncedVersion(this.state),
      updates.map((u) => ({ clientID: u.clientID, changes: u.changes.toJSON() })),
    );
  }

  handle(message: HostMessage): void {
    if (message.type === 'updates') {
      const synced = getSyncedVersion(this.state);
      const updates = message.updates
        .slice(synced - message.fromVersion)
        .map((u) => ({ clientID: u.clientID, changes: ChangeSet.fromJSON(u.changes) }));
      if (updates.length) this.state = this.state.update(receiveUpdates(this.state, updates)).state;
    } else if (message.type === 'pushResult') {
      this.pushing = false;
    } else if (message.type === 'reset') {
      this.state = EditorState.create({ doc: message.text, extensions: [collab({ startVersion: message.version, clientID: 'web' })] });
    }
  }
}

function setup(text: string) {
  const document = new FakeDocument(text);
  const inbox: HostMessage[] = [];
  const authority = new Authority(document, (m) => inbox.push(m));
  const client = new Client(authority.text, authority.version);
  const deliver = async () => {
    await authority.idle();
    while (inbox.length) client.handle(inbox.shift()!);
  };
  return { document, authority, client, deliver };
}

describe('diffToChanges', () => {
  it('produces the minimal single replacement', () => {
    const changes = diffToChanges('hello world', 'hello brave world');
    expect(changes.apply(EditorState.create({ doc: 'hello world' }).doc).toString()).toBe('hello brave world');
    const spans: number[][] = [];
    changes.iterChanges((fromA, toA) => spans.push([fromA, toA]));
    expect(spans).toEqual([[6, 6]]);
  });
});

describe('Authority', () => {
  it('applies client edits to the document', async () => {
    const { document, client, authority, deliver } = setup('# Title\n\nbody\n');
    client.edit(9, 9, 'more ');
    client.push(authority);
    await deliver();
    expect(document.text).toBe('# Title\n\nmore body\n');
    expect(sendableUpdates(client.state)).toHaveLength(0);
    expect(getSyncedVersion(client.state)).toBe(authority.version);
  });

  it('keeps CRLF documents intact', async () => {
    const { document, client, authority, deliver } = setup('a\r\nb\r\nc');
    expect(client.state.doc.toString()).toBe('a\nb\nc');
    client.edit(4, 5, 'C\nD');
    client.push(authority);
    await deliver();
    expect(document.text).toBe('a\r\nb\r\nC\r\nD');
  });

  it('forwards outside edits to the client', async () => {
    const { document, client, authority, deliver } = setup('one\ntwo\n');
    document.text = 'one\n2\ntwo\n';
    authority.documentChanged();
    await deliver();
    expect(client.state.doc.toString()).toBe('one\n2\ntwo\n');
  });

  it('converges when an outside edit races a client push', async () => {
    const { document, client, authority, deliver } = setup('alpha\nbeta\ngamma\n');
    // The client types at the end while the file changes at the start.
    client.edit(17, 17, 'delta\n');
    document.text = 'ALPHA!\nbeta\ngamma\n';
    authority.documentChanged();
    client.push(authority);
    await deliver();
    // The first push was rejected; the client rebased and pushes again.
    client.push(authority);
    await deliver();
    expect(document.text).toBe('ALPHA!\nbeta\ngamma\ndelta\n');
    expect(client.state.doc.toString()).toBe(document.text);
  });

  it('survives many interleaved edits', async () => {
    const { document, client, authority, deliver } = setup('');
    for (let i = 0; i < 30; i++) {
      client.edit(client.state.doc.length, client.state.doc.length, `line ${i}\n`);
      if (i % 4 === 0) {
        document.text = `# head ${i}\n` + document.text.replace(/^# head \d+\n/, '');
        authority.documentChanged();
      }
      client.push(authority);
      await deliver();
    }
    client.push(authority);
    await deliver();
    expect(client.state.doc.toString()).toBe(document.text);
    expect(document.text.startsWith('# head 28\n')).toBe(true);
    expect(document.text).toContain('line 29\n');
  });
});
