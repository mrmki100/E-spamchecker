import {
    handleTCPOutBound,
    makeReadableWebSocketStream,
    safeCloseTcpSocket
} from '@common';

export async function SsOverWSHandler(request: Request): Promise<Response> {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();

    let address = "";
    let portWithRandomLog = "";

    const log = (info: string, event?: string) => {
        // لاگ را برای پرفورمنس خاموش کردیم
    };

    const earlyDataHeader = request.headers.get("sec-websocket-protocol") || "";
    const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);

    let remoteSocketWapper: { value: any } = { value: null };
    let udpStreamWrite: any = null;

    const writableStream = new WritableStream({
        async write(chunk, _controller) {
            if (udpStreamWrite) {
                return udpStreamWrite(chunk);
            }

            if (remoteSocketWapper.value) {
                const writer = remoteSocketWapper.value.writable.getWriter();
                await writer.write(chunk);
                writer.releaseLock();
                return;
            }

            // پارس کردن هدر Shadowsocks (متد none شبیه ساکس5 خام است)
            const {
                hasError,
                message,
                portRemote = 443,
                addressRemote = "",
                rawClientData,
            } = parseSsHeader(chunk);

            address = addressRemote;
            portWithRandomLog = `${portRemote}--${Math.random()} tcp`;

            if (hasError) {
                console.log(`SS Error: ${message}`);
                throw new Error(message);
            }

            handleTCPOutBound(
                remoteSocketWapper,
                addressRemote,
                portRemote,
                rawClientData,
                webSocket,
                null, // هدر پاسخ برای SS نیاز نیست
                log
            );
        },
        close() {
            safeCloseTcpSocket(remoteSocketWapper.value);
        },
        abort(reason) {
            safeCloseTcpSocket(remoteSocketWapper.value);
        }
    });

    readableWebSocketStream
        .pipeTo(writableStream)
        .catch(error => {
            safeCloseTcpSocket(remoteSocketWapper.value);
        });

    return new Response(null, {
        status: 101,
        webSocket: client,
    });
}

function parseSsHeader(buffer: ArrayBuffer) {
    if (buffer.byteLength < 7) {
        return { hasError: true, message: "invalid data length" };
    }

    const view = new DataView(buffer);
    const atype = view.getUint8(0); // بایت اول نوع آدرس است

    let addressLength = 0;
    let addressIndex = 1;
    let address = "";

    switch (atype) {
        case 1: // IPv4
            addressLength = 4;
            address = new Uint8Array(buffer.slice(addressIndex, addressIndex + addressLength)).join(".");
            break;

        case 3: // Domain
            addressLength = new Uint8Array(buffer.slice(addressIndex, addressIndex + 1))[0];
            addressIndex += 1;
            address = new TextDecoder().decode(buffer.slice(addressIndex, addressIndex + addressLength));
            break;

        case 4: // IPv6
            addressLength = 16;
            const dataView = new DataView(buffer.slice(addressIndex, addressIndex + addressLength));
            const ipv6 = [];
            for (let i = 0; i < 8; i++) {
                ipv6.push(dataView.getUint16(i * 2).toString(16));
            }
            address = ipv6.join(":");
            break;

        default:
            return { hasError: true, message: `invalid addressType: ${atype}` };
    }

    if (!address) {
        return { hasError: true, message: "address is empty" };
    }

    const portIndex = addressIndex + addressLength;
    const portBuffer = buffer.slice(portIndex, portIndex + 2);
    const portRemote = new DataView(portBuffer).getUint16(0);

    return {
        hasError: false,
        addressRemote: address,
        portRemote,
        rawClientData: buffer.slice(portIndex + 2), // داده‌های بعد از هدرس
    };
}