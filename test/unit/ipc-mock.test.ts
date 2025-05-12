import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, createConnection, resetMockIpc } from '../../src/test-doubles/ipc-mock';
import type { IMockServer, IMockSocket } from '../../src/test-doubles/ipc-mock'; // Use import type

const TEST_SOCKET_PATH = '/tmp/test-ipc-mock.sock';
const LOGS_CHOPPED = 'LOGS_CHOPPED'; // Defined locally for test
const INPUT_SENT = 'INPUT_SENT';     // Defined locally for test

describe('ipc-mock', () => {
    let server: IMockServer;
    let client: IMockSocket;

    beforeEach(() => {
        resetMockIpc(); // Ensures clean state
    });

    afterEach(async () => {
        if (client && !client.destroyed) {
            client.destroy();
            // Give a brief moment for destroy to propagate if needed, but don't hang.
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        if (server && (server as IMockServer)._listeningPath) { // Check if server was actually started
            try {
                await new Promise<void>((resolve, reject) => {
                    server.once('close', resolve);
                    server.once('error', (e) => {
                        // Suppress EADDRINUSE if another test quickly reuses the socket
                        if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') reject(e);
                        else resolve();
                    });
                    server.close();
                    // Safety net if 'close' or 'error' don't fire
                    setTimeout(() => resolve(), 50);
                });
            } catch (e) {
                // console.warn('Error during server close in afterEach:', e); // Optional: log for debugging
            }
        }
        resetMockIpc(); // This clears activeServers, so server.close() above is important
    });

    it('should handle request-logs command and respond with LOGS_CHOPPED', async () => {
        server = createServer((socket) => {
            socket.on('data', (data) => {
                const message = JSON.parse(data.toString());
                if (message.command === 'request-logs') {
                    socket.write(LOGS_CHOPPED);
                }
            });
        });
        await new Promise<void>(resolve => server.listen(TEST_SOCKET_PATH, resolve));

        client = createConnection(TEST_SOCKET_PATH);
        await new Promise<void>(resolve => client.once('connect', resolve));

        const responsePromise = new Promise<string>(resolve => {
            client.on('data', (data) => resolve(data.toString()));
        });

        client.write(JSON.stringify({ command: 'request-logs' }));
        const response = await responsePromise;
        expect(response).toBe(LOGS_CHOPPED);
    });

    it('should handle send-input command and respond with INPUT_SENT', async () => {
        const testInputData = 'hello from client';
        let receivedByServer = '';

        server = createServer((socket) => {
            socket.on('data', (data) => {
                const message = JSON.parse(data.toString());
                if (message.command === 'send-input') {
                    receivedByServer = message.input;
                    socket.write(INPUT_SENT);
                }
            });
        });
        await new Promise<void>(resolve => server.listen(TEST_SOCKET_PATH, resolve));

        client = createConnection(TEST_SOCKET_PATH);
        await new Promise<void>(resolve => client.once('connect', resolve));

        const responsePromise = new Promise<string>(resolve => {
            client.on('data', (data) => resolve(data.toString()));
        });

        client.write(JSON.stringify({ command: 'send-input', input: testInputData }));
        const response = await responsePromise;

        expect(receivedByServer).toBe(testInputData);
        expect(response).toBe(INPUT_SENT);
    });

    it('client should receive error if server is not listening on connect', async () => {
        // No server.listen here
        client = createConnection(TEST_SOCKET_PATH);

        const errorPromise = new Promise<Error>((resolve, reject) => {
            client.on('error', (err) => resolve(err));
            // Safety timeout for the promise itself, in case 'error' is never emitted.
            setTimeout(() => reject(new Error('errorPromise timed out in test')), 5000);
        });

        await expect(errorPromise).resolves.toBeInstanceOf(Error);
        const err = await errorPromise;
        expect((err as NodeJS.ErrnoException).code).toBe('ECONNREFUSED');
    });

    it('server should handle multiple client connections', async () => {
        let connectionCount = 0;
        server = createServer((socket) => { // Use the socket passed to the listener
            connectionCount++;
            // Set up echo handler ON the server-side socket for THIS connection
            socket.on('data', (data) => {
                if (!socket.destroyed) {
                    socket.write(data.toString().toUpperCase());
                }
            });
        });
        await new Promise<void>(resolve => server.listen(TEST_SOCKET_PATH, resolve));

        const client1 = createConnection(TEST_SOCKET_PATH);
        const client2 = createConnection(TEST_SOCKET_PATH);

        // NO specific data handlers needed on clients for echo test
        // client1.on('data', (data) => client1.write(data.toString().toUpperCase())); // REMOVED
        // client2.on('data', (data) => client2.write(data.toString().toUpperCase())); // REMOVED

        await Promise.all([
            new Promise<void>(resolve => client1.once('connect', resolve)),
            new Promise<void>(resolve => client2.once('connect', resolve)),
        ]);

        const response1Promise = new Promise<string>(resolve => client1.once('data', data => resolve(data.toString())));
        const response2Promise = new Promise<string>(resolve => client2.once('data', data => resolve(data.toString())));

        // Send data from clients to the server
        client1.write('hello');
        client2.write('world');

        // The 'data' listeners on client1 and client2 will receive the echoed (uppercased) data FROM THE SERVER.

        const [response1, response2] = await Promise.all([response1Promise, response2Promise]);

        expect(response1).toBe('HELLO');
        expect(response2).toBe('WORLD');

        expect(server._connections.size).toBe(2); // Verify internal tracking on server

        client1.destroy();
        client2.destroy();
    });
}); 