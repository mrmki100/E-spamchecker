import { connect } from 'cloudflare:sockets';

export enum HttpStatus {
    OK = 200,
    BAD_REQUEST = 400,
    UNAUTHORIZED = 401,
    FORBIDDEN = 403,
    NOT_FOUND = 404,
    METHOD_NOT_ALLOWED = 405,
    INTERNAL_SERVER_ERROR = 500
}

export function base64EncodeUtf8(str: string) {
    return btoa(
        String.fromCharCode(...new TextEncoder().encode(str))
    );
}

export function base64DecodeUtf8(base64: string) {
    return new TextDecoder().decode(
        Uint8Array.from(atob(base64), c => c.charCodeAt(0))
    );
}

export function isValidUUID(uuid: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
}

export function respond(
    success: boolean,
    status: HttpStatus,
    message?: string,
    body?: any,
    customHeaders?: Record<string, string>
): Response {
    const headers = {
        'Content-Type': 'application/json',
        ...customHeaders,
    };

    const responseBody = {
        success,
        status,
        message: message ?? null,
        body: body ?? null,
    };

    return new Response(JSON.stringify(responseBody), { status, headers });
}

/**
 * توابع جدید اضافه شده برای مدیریت شبکه و شادوساکس
 */

export function safeCloseTcpSocket(socket: any) {
    try {
        if (socket && typeof socket.close === 'function') {
            socket.close();
        }
    } catch (e) {
        // ignore errors
    }
}

export function makeReadableWebSocketStream(webSocketServer: WebSocket, earlyDataHeader: string, log: Function) {
    let readableStreamCancel = false;
    const stream = new ReadableStream({
        start(controller) {
            webSocketServer.addEventListener('message', (event) => {
                if (readableStreamCancel) {
                    return;
                }
                const message = event.data;
                controller.enqueue(message);
            });
            webSocketServer.addEventListener('close', () => {
                safeCloseTcpSocket(webSocketServer);
                if (readableStreamCancel) {
                    return;
                }
                controller.close();
            });
            webSocketServer.addEventListener('error', (err) => {
                log('webSocketServer has error');
                controller.error(err);
            });
            if (earlyDataHeader) {
                controller.enqueue(base64DecodeUtf8(earlyDataHeader));
            }
        },
        pull(controller) {
            // no-op
        },
        cancel(reason) {
            if (readableStreamCancel) {
                return;
            }
            log(`ReadableStream was canceled, due to ${reason}`)
            readableStreamCancel = true;
            safeCloseTcpSocket(webSocketServer);
        }
    });
    return stream;
}

export async function handleTCPOutBound(
    remoteSocket: any,
    addressRemote: string,
    portRemote: number,
    rawClientData: Uint8Array,
    webSocket: WebSocket,
    responseHeader: Uint8Array | null,
    log: Function
) {
    async function connectAndWrite(address: string, port: number) {
        // @ts-ignore
        const tcpSocket = connect({
            hostname: address,
            port: port,
        });
        remoteSocket.value = tcpSocket;
        log(`connected to ${address}:${port}`);
        const writer = tcpSocket.writable.getWriter();
        await writer.write(rawClientData);
        writer.releaseLock();
        return tcpSocket;
    }

    const tcpSocket = await connectAndWrite(addressRemote, portRemote);
    remoteSocketToWS(tcpSocket, webSocket, responseHeader, log);
}

async function remoteSocketToWS(remoteSocket: any, webSocket: WebSocket, responseHeader: Uint8Array | null, log: Function) {
    let hasHeader = false;
    await remoteSocket.readable.pipeTo(new WritableStream({
        start() { },
        async write(chunk, controller) {
            if (hasHeader) {
                webSocket.send(chunk);
            } else {
                if (responseHeader) {
                    webSocket.send(await new Blob([responseHeader, chunk]).arrayBuffer());
                    hasHeader = true;
                } else {
                    webSocket.send(chunk);
                    hasHeader = true;
                }
            }
        },
        close() {
            log(`remoteConnection!.readable is close`);
        },
        abort(reason) {
            console.error(`remoteConnection!.readable abort`, reason);
        },
    })).catch((error: any) => {
        console.error(`remoteSocketToWS error:`, error.stack || error);
        safeCloseTcpSocket(remoteSocket);
    });
}
