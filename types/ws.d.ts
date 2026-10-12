// Minimal typings for the `ws` package (only the parts Parley uses).
declare module 'ws' {
  import { EventEmitter } from 'node:events';
  import type { IncomingMessage } from 'node:http';
  import type { Duplex } from 'node:stream';

  export class WebSocket extends EventEmitter {
    static readonly OPEN: 1;
    readonly readyState: number;
    constructor(url: string, opts?: { headers?: Record<string, string> });
    send(data: string | Buffer, cb?: (err?: Error) => void): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    ping(): void;
    on(event: 'message', cb: (data: Buffer, isBinary: boolean) => void): this;
    on(event: 'close', cb: (code: number, reason: Buffer) => void): this;
    on(event: 'pong' | 'open', cb: () => void): this;
    on(event: 'error', cb: (err: Error) => void): this;
    once(event: string, cb: (...args: any[]) => void): this;
  }
  export class WebSocketServer extends EventEmitter {
    constructor(opts: { noServer?: boolean; maxPayload?: number });
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, cb: (ws: WebSocket) => void): void;
    close(): void;
  }
  export default WebSocket;
}
