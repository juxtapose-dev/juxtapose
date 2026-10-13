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

/** A frame grew past the framer's cap before its NUL arrived. */
export class FrameTooLargeError extends Error {
  constructor(limit: number) {
    super(`jux: a frame exceeded ${limit} characters`);
    this.name = 'FrameTooLargeError';
  }
}

export class NullFramer {
  // Pieces of the frame in progress. Joined once when its NUL arrives and only
  // the new chunk is scanned: re-slicing one growing string made a 20 MB frame
  // in 64 KB chunks cost 339 ms (40 MB: 1.5 s), quadratic in frame size.
  private parts: string[] = [];
  private partsChars = 0;
  // Chunk boundaries can fall inside a multi-byte UTF-8 character; a plain
  // toString() per chunk would corrupt it into U+FFFD.
  private readonly decoder = new StringDecoder('utf8');

  /**
   * `maxFrameChars` bounds one frame. Chrome's pipe is trusted and uncapped;
   * the supervisor caps its clients so one that never sends a NUL cannot grow
   * the daemon's memory without bound. Past the cap, push() throws.
   */
  constructor(private readonly maxFrameChars = Infinity) {}

  push(chunk: Buffer | string, onFrame: (frame: string) => void): void {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let start = 0;
    let end: number;
    while ((end = text.indexOf('\0', start)) >= 0) {
      this.parts.push(text.slice(start, end));
      this.partsChars += end - start;
      if (this.partsChars > this.maxFrameChars)
        throw new FrameTooLargeError(this.maxFrameChars);
      const frame = this.parts.length === 1 ? this.parts[0] : this.parts.join('');
      this.parts = [];
      this.partsChars = 0;
      start = end + 1;
      onFrame(frame);
    }
    if (start < text.length) {
      this.parts.push(text.slice(start));
      this.partsChars += text.length - start;
      if (this.partsChars > this.maxFrameChars)
        throw new FrameTooLargeError(this.maxFrameChars);
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

  // Outgoing writes are unbounded on purpose: CDP commands are small and the
  // driver awaits replies, so the write queue stays short. The PR 2 supervisor
  // proxies arbitrary client traffic and must honor write() back-pressure
  // (drain) itself before it forwards large payloads.
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
    private readonly readable: NodeJS.ReadableStream,
  ) {
    super();
    readable.on('data', this.onData);
    readable.on('close', () => this.emitClose('pipe closed'));
    readable.on('error', (e: Error) => this.emitClose(e.message));
    writable.on('error', (e: Error) => this.emitClose(e.message));
  }
  private readonly onData = (chunk: Buffer): void => this.feed(chunk);
  protected write(data: string): void {
    this.writable.write(data);
  }
  protected destroy(): void {
    // The process owns the fds (launch.ts closes them with the process); we
    // only stop listening so a closed transport delivers nothing more.
    this.readable.removeListener('data', this.onData);
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
