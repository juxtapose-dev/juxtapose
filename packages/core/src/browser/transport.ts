// packages/core/src/browser/transport.ts
//
// Two byte pipes, one framing. Chrome's --remote-debugging-pipe speaks
// NUL-terminated JSON on fds 3 (in) and 4 (out); the warm-browser supervisor
// (PR 2) speaks the same framing over a local socket so one CdpConnection
// serves both.

import type net from 'node:net';
import { StringDecoder } from 'node:string_decoder';

export interface Transport {
  send(message: string): void;
  onMessage: ((message: string) => void) | null;
  onClose: ((reason?: string) => void) | null;
  close(): void;
}

export class NullFramer {
  private buffer = '';
  // Chunk boundaries can fall inside a multi-byte UTF-8 character; a plain
  // toString() per chunk would corrupt it into U+FFFD.
  private readonly decoder = new StringDecoder('utf8');
  push(chunk: Buffer | string, onFrame: (frame: string) => void): void {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let end: number;
    while ((end = this.buffer.indexOf('\0')) >= 0) {
      const frame = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      onFrame(frame);
    }
  }
}

/** Framing, close-once and callback plumbing shared by both transports. */
export abstract class FramedTransport implements Transport {
  onMessage: ((message: string) => void) | null = null;
  onClose: ((reason?: string) => void) | null = null;
  private readonly framer = new NullFramer();
  private closed = false;

  protected abstract write(data: string): void;
  protected abstract destroy(): void;

  protected feed(chunk: Buffer | string): void {
    this.framer.push(chunk, (f) => this.onMessage?.(f));
  }

  send(message: string): void {
    if (this.closed) return;
    this.write(message + '\0');
  }

  close(): void {
    this.destroy();
    this.emitClose('closed');
  }

  protected emitClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.(reason);
  }
}

export class PipeTransport extends FramedTransport {
  constructor(
    private readonly writable: NodeJS.WritableStream,
    readable: NodeJS.ReadableStream,
  ) {
    super();
    readable.on('data', (chunk: Buffer) => this.feed(chunk));
    readable.on('close', () => this.emitClose('pipe closed'));
    readable.on('error', (e: Error) => this.emitClose(e.message));
    writable.on('error', (e: Error) => this.emitClose(e.message));
  }
  protected write(data: string): void {
    this.writable.write(data);
  }
  protected destroy(): void {
    // The process owns the fds; launch.ts closes them with the process.
  }
}

export class SocketTransport extends FramedTransport {
  constructor(private readonly socket: net.Socket) {
    super();
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => this.feed(chunk));
    socket.on('close', () => this.emitClose('socket closed'));
    socket.on('error', (e) => this.emitClose(e.message));
  }
  protected write(data: string): void {
    this.socket.write(data);
  }
  protected destroy(): void {
    this.socket.destroy();
  }
}
