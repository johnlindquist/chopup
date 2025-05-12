import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';

// @ts-ignore - MockDuplex is a minimal mock and intentionally doesn't fully implement Duplex
export class MockDuplex extends EventEmitter implements Duplex {
    writable = true;
    readable = true;
    readableHighWaterMark = 16384;
    writableHighWaterMark = 16384;
    readableLength = 0;
    writableLength = 0;
    writableCorked = 0;
    destroyed = false;

    _dataBuffer: unknown[] = [];
    _isReading = false;

    write(chunk: unknown, encodingOrCb?: BufferEncoding | ((error?: Error | null) => void), cb?: (error?: Error | null) => void): boolean {
        let newChunk = chunk;
        let newEncodingOrCb = encodingOrCb;
        let newCb = cb;

        if (typeof chunk === 'string') {
            if (typeof encodingOrCb === 'string') {
                // write(string, encoding, cb)
            } else if (typeof encodingOrCb === 'function') {
                // write(string, cb)
                newCb = encodingOrCb;
                newEncodingOrCb = undefined; // Use undefined instead of null
            } else {
                // write(string)
                newEncodingOrCb = undefined; // Use undefined instead of null
            }
        } else if (chunk instanceof Buffer || chunk instanceof Uint8Array) {
            if (typeof encodingOrCb === 'function') {
                // write(buffer, cb)
                newCb = encodingOrCb;
                newEncodingOrCb = undefined; // Use undefined instead of null
            } else {
                // write(buffer)
            }
        } else if (typeof chunk === 'function') {
            // Handle case where chunk is callback (write(cb))
            newCb = chunk as () => void;
            newChunk = null; // chunk is null here
            newEncodingOrCb = undefined; // Use undefined instead of null
        } else if (typeof newEncodingOrCb === 'function') {
            newCb = newEncodingOrCb as () => void;
            newEncodingOrCb = undefined; // Use undefined instead of null
        }

        if (this.destroyed) {
            const err = new Error('write after destroyed');
            if (newCb) {
                process.nextTick(newCb, err);
            } else {
                process.nextTick(() => this.emit('error', err));
            }
            return false;
        }
        this.emit('_data_to_other_side', newChunk);
        if (newCb) process.nextTick(newCb, null);
        return true;
    }

    end(cb?: () => void): this;
    end(chunk: unknown, cb?: () => void): this;
    end(chunk: unknown, encoding?: BufferEncoding, cb?: () => void): this;
    end(chunk?: unknown, encodingOrCb?: BufferEncoding | (() => void), cb?: () => void): this {
        let newCb = cb;
        let newChunk = chunk;
        let newEncodingOrCb = encodingOrCb;

        if (typeof newChunk === 'function') {
            newCb = newChunk as () => void;
            newChunk = null;
            newEncodingOrCb = null;
        } else if (typeof newEncodingOrCb === 'function') {
            newCb = newEncodingOrCb as () => void;
            newEncodingOrCb = null;
        }

        if (newChunk && this.writable) {
            this.write(newChunk, newEncodingOrCb as BufferEncoding | undefined, () => {
                this.writable = false;
                process.nextTick(() => this.emit('finish'));
                if (newCb) process.nextTick(newCb);
            });
        } else {
            this.writable = false;
            process.nextTick(() => this.emit('finish'));
            if (newCb) process.nextTick(newCb);
        }

        this.emit('_end_to_other_side');
        return this;
    }

    _receiveData(chunk: unknown) {
        if (this.readable && !this.destroyed) {
            this._dataBuffer.push(chunk);
            if (this._isReading) {
                while (this._dataBuffer.length > 0 && this.readable && !this.destroyed) {
                    const dataToEmit = this._dataBuffer.shift();
                    this.emit('data', dataToEmit);
                }
            }
        }
    }

    _receiveEnd() {
        if (this.readable && !this.destroyed) {
            this.readable = false;
            process.nextTick(() => this.emit('end'));
        }
    }

    read(size?: number): unknown {
        this._isReading = true;
        if (this._dataBuffer.length > 0) {
            return this._dataBuffer.shift();
        }
        return null;
    }

    pause(): this { this._isReading = false; return this; }
    resume(): this {
        this._isReading = true;
        process.nextTick(() => {
            while (this._dataBuffer.length > 0 && this.readable && !this.destroyed && this._isReading) {
                this.emit('data', this._dataBuffer.shift());
            }
        });
        return this;
    }
    isPaused(): boolean { return !this._isReading; }
    setEncoding(encoding: BufferEncoding): this { return this; }

    destroy(error?: Error | null): this {
        if (this.destroyed) return this;
        this.destroyed = true;
        this.writable = false;
        this.readable = false;

        this._dataBuffer = [];

        process.nextTick(() => {
            if (error) {
                this.emit('error', error);
            }
            this.emit('close');
        });
        return this;
    }

    _write(chunk: unknown, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        this.write(chunk, encoding, callback);
    }
    _read(size: number): void {
    }
    _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        this.destroy(error);
        callback(error);
    }
    pipe<T extends NodeJS.WritableStream>(destination: T, options?: { end?: boolean; }): T {
        const onData = (chunk: unknown) => {
            // Ensure chunk is Buffer or string before writing
            const dataToWrite = chunk instanceof Buffer ? chunk : String(chunk);
            if (!destination.write(dataToWrite)) {
                this.pause();
                destination.once('drain', () => this.resume());
            }
        };
        this.on('data', onData);

        const onEnd = () => {
            if (options?.end !== false) {
                destination.end();
            }
        };
        this.once('end', onEnd);

        let errored = false;
        const onError = (err: Error) => {
            if (errored) return;
            errored = true;
            this.removeListener('data', onData);
            this.removeListener('end', onEnd);
            destination.emit('error', err);
        }
        this.once('error', onError);
        destination.once('error', (err) => {
            if (errored) return;
            errored = true;
            this.removeListener('data', onData);
            this.removeListener('end', onEnd);
            this.emit('error', err);
        });

        return destination;
    }
    unpipe(destination?: NodeJS.WritableStream): this {
        if (destination) {
            this.removeAllListeners('data');
            this.removeAllListeners('end');
            this.removeAllListeners('error');
        }
        return this;
    }
    unshift(chunk: unknown, encoding?: BufferEncoding): void {
        if (this.readable && !this.destroyed) {
            this._dataBuffer.unshift(chunk);
        }
    }
    wrap(stream: NodeJS.ReadableStream): this { return this; }

    [Symbol.asyncIterator](): AsyncIterableIterator<unknown> {
        const stream = this;
        async function* gen() {
            let listener: (() => void) | null = null;
            const buffer: unknown[] = [];
            let ended = false;
            let error: Error | null = null;

            const onData = (chunk: unknown) => {
                buffer.push(chunk);
                if (listener) listener();
            };
            const onEnd = () => {
                ended = true;
                if (listener) listener();
            };
            const onError = (err: Error) => {
                error = err;
                if (listener) listener();
            };

            stream.on('data', onData);
            stream.on('end', onEnd);
            stream.on('error', onError);

            try {
                while (true) {
                    if (error) throw error;
                    if (buffer.length > 0) {
                        yield buffer.shift();
                        continue;
                    }
                    if (ended) return;

                    await new Promise<void>(resolve => {
                        listener = resolve;
                    });
                    listener = null;
                }
            } finally {
                stream.removeListener('data', onData);
                stream.removeListener('end', onEnd);
                stream.removeListener('error', onError);
            }
        }
        return gen();
    }

    _final(callback: (error?: Error | null) => void): void {
        process.nextTick(() => callback());
    }
}

export interface IMockServer extends EventEmitter {
    listen: (path: string, callback?: () => void) => IMockServer;
    close: (callback?: (err?: Error) => void) => IMockServer;
    address: () => string | { path: string, port: number | null, family: string, address: string | null } | null;
    _simulateConnection: (clientSocket: IMockSocket) => void;
}

export interface IMockSocket extends MockDuplex {
    connect: (path: string, connectListener?: () => void) => void;
    _simulateDataFromServer: (data: string | Buffer) => void;
    _simulateEndFromServer: () => void;
}

const activeServers = new Map<string, IMockServer>();
const serverUserConnectionListeners = new Map<string, (socket: IMockSocket) => void>();

export function createServer(userConnectionListener: (socket: IMockSocket) => void): IMockServer {
    const server = new EventEmitter() as IMockServer;
    let listeningPath: string | null = null;
    let isClosed = false;

    server.listen = (path, callback): IMockServer => {
        if (isClosed) {
            if (callback) process.nextTick(callback);
            return server;
        }
        if (activeServers.has(path)) {
            const err = new Error(`EADDRINUSE: address already in use ${path}`) as NodeJS.ErrnoException;
            err.code = 'EADDRINUSE';
            process.nextTick(() => server.emit('error', err));
            if (callback) process.nextTick(callback);
            return server;
        }
        listeningPath = path;
        activeServers.set(path, server);
        serverUserConnectionListeners.set(path, userConnectionListener);

        if (callback) process.nextTick(callback);
        process.nextTick(() => server.emit('listening'));
        return server;
    };

    server.close = (callback): IMockServer => {
        if (isClosed) {
            if (callback) process.nextTick(callback);
            return server;
        }
        isClosed = true;
        if (listeningPath) {
            activeServers.delete(listeningPath);
            serverUserConnectionListeners.delete(listeningPath);
        }
        process.nextTick(() => server.emit('close'));
        if (callback) process.nextTick(callback);
        listeningPath = null;
        return server;
    };

    server.address = () => listeningPath ? { path: listeningPath, port: null, family: 'IPC', address: listeningPath } : null;

    (server as IMockServer)._simulateConnection = (clientSocket: IMockSocket) => {
        if (isClosed || !listeningPath) {
            process.nextTick(() => clientSocket.emit('error', new Error('Server not listening or closed')));
            return;
        }
        const userListener = serverUserConnectionListeners.get(listeningPath);
        if (userListener) {
            const serverSideSocket = new MockDuplex() as IMockSocket;

            clientSocket.on('_data_to_other_side', (data) => {
                serverSideSocket._receiveData(data);
            });
            serverSideSocket.on('_data_to_other_side', (data) => {
                clientSocket._receiveData(data);
            });

            clientSocket.on('_end_to_other_side', () => serverSideSocket._receiveEnd());
            serverSideSocket.on('_end_to_other_side', () => clientSocket._receiveEnd());

            (serverSideSocket as IMockSocket)._simulateDataFromServer = (data: string | Buffer) => serverSideSocket._receiveData(data);
            (serverSideSocket as IMockSocket)._simulateEndFromServer = () => serverSideSocket._receiveEnd();

            // Patch: wire up stdin/stdout/stderr for fake child compatibility
            (serverSideSocket as IMockSocket).stdin = clientSocket;
            (serverSideSocket as IMockSocket).stdout = serverSideSocket;
            (serverSideSocket as IMockSocket).stderr = serverSideSocket;
            (clientSocket as IMockSocket).stdin = serverSideSocket;
            (clientSocket as IMockSocket).stdout = clientSocket;
            (clientSocket as IMockSocket).stderr = clientSocket;

            userListener(serverSideSocket);
            process.nextTick(() => {
                clientSocket.emit('connect');
                clientSocket.resume?.(); // Use optional chaining
                serverSideSocket.resume?.(); // Use optional chaining
            });
        } else {
            process.nextTick(() => clientSocket.emit('error', new Error(`No listener for path ${listeningPath}`)));
        }
    };

    return server;
}

export function createConnection(arg1: string | { path: string }, userConnectListener?: () => void): IMockSocket {
    const actualPath = typeof arg1 === 'string' ? arg1 : arg1.path;
    const clientSocket = new MockDuplex() as IMockSocket;

    (clientSocket as IMockSocket)._simulateDataFromServer = (data: string | Buffer) => clientSocket._receiveData(data);
    (clientSocket as IMockSocket)._simulateEndFromServer = () => clientSocket._receiveEnd();

    if (userConnectListener) {
        clientSocket.once('connect', userConnectListener);
    }

    clientSocket.connect = (p, cb) => {
        if (cb) clientSocket.once('connect', cb);

        const serverInstance = activeServers.get(actualPath);
        if (!serverInstance) {
            const err = new Error(`ECONNREFUSED: connect ECONNREFUSED ${actualPath}`) as NodeJS.ErrnoException;
            err.code = 'ECONNREFUSED';
            process.nextTick(() => clientSocket.emit('error', err));
            return;
        }
        const userListener = serverUserConnectionListeners.get(actualPath);
        if (userListener) {
            serverInstance._simulateConnection(clientSocket);
        } else {
            const err = new Error(`ECONNREFUSED: connect ECONNREFUSED ${actualPath}`) as NodeJS.ErrnoException;
            err.code = 'ECONNREFUSED';
            process.nextTick(() => clientSocket.emit('error', err));
        }
    };

    clientSocket.connect(actualPath);

    return clientSocket;
}

export function resetMockIpc() {
    for (const server of activeServers.values()) {
        if (server.close && typeof server.close === 'function') {
            server.close();
        }
    }
    activeServers.clear();
    serverUserConnectionListeners.clear();
} 
