import type { HostMessage, WebviewMessage } from '../src/protocol';

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | undefined;

export function post(message: WebviewMessage): void {
  api ??= acquireVsCodeApi();
  api.postMessage(message);
}

export function onHostMessage(handler: (message: HostMessage) => void): void {
  window.addEventListener('message', (event: MessageEvent<HostMessage>) => handler(event.data));
}
