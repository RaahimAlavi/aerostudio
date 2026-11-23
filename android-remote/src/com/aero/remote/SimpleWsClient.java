package com.aero.remote;

import android.util.Base64;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Collections;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicReference;

import javax.net.ssl.SNIHostName;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * Lightweight, zero-dependency RFC-6455 WebSocket Client (supports ws:// and wss:// with SNI).
 * Uses a dedicated non-blocking single-slot latest-frame writer thread for binary motion fallback
 * so TCP congestion can NEVER stall the 240Hz IMU sensor thread or build up latency queues.
 */
public class SimpleWsClient {

    public interface Callback {
        void onOpen();
        void onText(String text);
        void onClose(String reason);
    }

    private final Callback callback;
    private final SecureRandom rng = new SecureRandom();
    private final Object writeLock = new Object();
    private final Object txSignal = new Object();
    private final ConcurrentLinkedQueue<byte[]> textQueue = new ConcurrentLinkedQueue<>();
    private final AtomicReference<byte[]> latestBinary = new AtomicReference<>(null);

    private volatile Socket socket;
    private volatile OutputStream out;
    private volatile boolean open = false;
    private volatile boolean closed = false;
    private Thread readThread;
    private Thread txThread;

    public SimpleWsClient(Callback callback) {
        this.callback = callback;
    }

    public boolean isOpen() {
        return open && !closed;
    }

    public void connect(String urlStr) {
        close();
        closed = false;
        textQueue.clear();
        latestBinary.set(null);
        readThread = new Thread(() -> runLoop(urlStr), "AeroWS-RX");
        readThread.start();
    }

    private void startTxThread() {
        txThread = new Thread(() -> {
            while (!closed && open) {
                boolean didWork = false;

                // Prioritize button/action JSON messages first
                byte[] txt = textQueue.poll();
                if (txt != null) {
                    sendFrame(0x01, txt);
                    didWork = true;
                }

                // Always transmit ONLY the single newest motion frame (never queue stale lag!)
                byte[] bin = latestBinary.getAndSet(null);
                if (bin != null) {
                    sendFrame(0x02, bin);
                    didWork = true;
                }

                if (!didWork) {
                    synchronized (txSignal) {
                        if (textQueue.isEmpty() && latestBinary.get() == null && !closed && open) {
                            try {
                                txSignal.wait(250);
                            } catch (InterruptedException ignored) {}
                        }
                    }
                }
            }
        }, "AeroWS-TX");
        txThread.start();
    }

    private void runLoop(String urlStr) {
        try {
            URI uri = URI.create(urlStr);
            boolean tls = "wss".equalsIgnoreCase(uri.getScheme());
            String host = uri.getHost();
            int port = uri.getPort() > 0 ? uri.getPort() : (tls ? 443 : 80);
            String path = (uri.getRawPath() == null || uri.getRawPath().isEmpty()) ? "/" : uri.getRawPath();
            if (uri.getRawQuery() != null && !uri.getRawQuery().isEmpty()) {
                path += "?" + uri.getRawQuery();
            }

            Socket sock;
            if (tls) {
                Socket raw = new Socket();
                raw.connect(new InetSocketAddress(host, port), 5000);
                raw.setTcpNoDelay(true);
                SSLSocketFactory sf = (SSLSocketFactory) SSLSocketFactory.getDefault();
                SSLSocket ssl = (SSLSocket) sf.createSocket(raw, host, port, true);
                try {
                    SSLParameters params = ssl.getSSLParameters();
                    params.setServerNames(Collections.singletonList(new SNIHostName(host)));
                    ssl.setSSLParameters(params);
                } catch (Exception ignored) {}
                ssl.setTcpNoDelay(true);
                ssl.startHandshake();
                sock = ssl;
            } else {
                sock = new Socket();
                sock.connect(new InetSocketAddress(host, port), 2600);
                sock.setTcpNoDelay(true);
            }
            socket = sock;
            out = sock.getOutputStream();
            BufferedInputStream in = new BufferedInputStream(sock.getInputStream(), 8192);

            byte[] keyBytes = new byte[16];
            rng.nextBytes(keyBytes);
            String wsKey = Base64.encodeToString(keyBytes, Base64.NO_WRAP);

            String hostHdr = (port == 80 || port == 443) ? host : (host + ":" + port);
            String req = "GET " + path + " HTTP/1.1\r\n"
                    + "Host: " + hostHdr + "\r\n"
                    + "User-Agent: AeroRemote/1.1\r\n"
                    + "Upgrade: websocket\r\n"
                    + "Connection: Upgrade\r\n"
                    + "Sec-WebSocket-Key: " + wsKey + "\r\n"
                    + "Sec-WebSocket-Version: 13\r\n\r\n";

            synchronized (writeLock) {
                out.write(req.getBytes(StandardCharsets.US_ASCII));
                out.flush();
            }

            String statusLine = readLine(in);
            if (statusLine == null || !statusLine.contains("101")) {
                throw new IOException("Handshake failed: " + statusLine);
            }
            while (true) {
                String hdr = readLine(in);
                if (hdr == null || hdr.isEmpty()) break;
            }

            open = true;
            startTxThread();
            if (callback != null) callback.onOpen();

            while (!closed) {
                int b0 = in.read();
                if (b0 < 0) break;
                int b1 = in.read();
                if (b1 < 0) break;

                int opcode = b0 & 0x0F;
                boolean masked = (b1 & 0x80) != 0;
                long len = b1 & 0x7F;
                if (len == 126) {
                    len = ((in.read() & 0xFF) << 8) | (in.read() & 0xFF);
                } else if (len == 127) {
                    len = 0;
                    for (int i = 0; i < 8; i++) len = (len << 8) | (in.read() & 0xFF);
                }
                if (len < 0 || len > 512 * 1024) break;

                byte[] mask = null;
                if (masked) {
                    mask = new byte[4];
                    readFully(in, mask);
                }

                byte[] payload = new byte[(int) len];
                if (len > 0) readFully(in, payload);
                if (masked) {
                    for (int i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
                }

                if (opcode == 0x01) {
                    String msg = new String(payload, StandardCharsets.UTF_8);
                    if (callback != null) callback.onText(msg);
                } else if (opcode == 0x08) {
                    break;
                } else if (opcode == 0x09) {
                    sendFrame(0x0A, payload);
                }
            }
        } catch (Exception e) {
            String reason = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
            cleanupSocket();
            if (!closed && callback != null) callback.onClose(reason);
            return;
        }
        cleanupSocket();
        if (!closed && callback != null) callback.onClose("Disconnected");
    }

    public void sendText(String text) {
        if (!isOpen() || text == null) return;
        textQueue.offer(text.getBytes(StandardCharsets.UTF_8));
        synchronized (txSignal) {
            txSignal.notify();
        }
    }

    /** Non-blocking latest-frame submit — overwrites any unsent older motion packet immediately. */
    public void sendBinaryLatest(byte[] copy18) {
        if (!isOpen() || copy18 == null) return;
        latestBinary.set(copy18);
        synchronized (txSignal) {
            txSignal.notify();
        }
    }

    private void sendFrame(int opcode, byte[] payload) {
        OutputStream o = this.out;
        if (o == null || closed) return;
        try {
            byte[] mask = new byte[4];
            rng.nextBytes(mask);
            int len = payload.length;
            byte[] raw;
            int headerLen = (len < 126) ? 6 : (len < 65536 ? 8 : 14);
            raw = new byte[headerLen + len];
            raw[0] = (byte) (0x80 | (opcode & 0x0F));
            int p = 2;
            if (len < 126) {
                raw[1] = (byte) (0x80 | len);
            } else if (len < 65536) {
                raw[1] = (byte) (0x80 | 126);
                raw[2] = (byte) ((len >>> 8) & 0xFF);
                raw[3] = (byte) (len & 0xFF);
                p = 4;
            } else {
                raw[1] = (byte) (0x80 | 127);
                for (int i = 0; i < 8; i++) raw[2 + i] = (byte) ((len >>> (56 - 8 * i)) & 0xFF);
                p = 10;
            }
            System.arraycopy(mask, 0, raw, p, 4);
            p += 4;
            for (int i = 0; i < len; i++) {
                raw[p + i] = (byte) (payload[i] ^ mask[i & 3]);
            }
            synchronized (writeLock) {
                o.write(raw);
                o.flush();
            }
        } catch (Exception ignored) {}
    }

    public void close() {
        closed = true;
        open = false;
        cleanupSocket();
        synchronized (txSignal) {
            txSignal.notifyAll();
        }
    }

    private void cleanupSocket() {
        open = false;
        Socket s = this.socket;
        this.socket = null;
        this.out = null;
        if (s != null) {
            try { s.close(); } catch (Exception ignored) {}
        }
        synchronized (txSignal) {
            txSignal.notifyAll();
        }
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream(128);
        while (true) {
            int c = in.read();
            if (c < 0) return buf.size() == 0 ? null : buf.toString("ISO-8859-1");
            if (c == '\n') {
                byte[] b = buf.toByteArray();
                int end = (b.length > 0 && b[b.length - 1] == '\r') ? b.length - 1 : b.length;
                return new String(b, 0, end, StandardCharsets.ISO_8859_1);
            }
            buf.write(c);
        }
    }

    private static void readFully(InputStream in, byte[] buf) throws IOException {
        int off = 0;
        while (off < buf.length) {
            int r = in.read(buf, off, buf.length - off);
            if (r < 0) throw new EOFException();
            off += r;
        }
    }
}
