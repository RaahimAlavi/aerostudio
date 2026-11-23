package com.aero.remote;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Process;
import android.os.SystemClock;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;

/**
 * Hardware 200-400Hz Android IMU Engine
 * - Explicit maxReportLatencyUs = 0 to disable MediaTek/vendor Sensor Hub FIFO batching
 * - Wi-Fi WMM Expedited Forwarding (DSCP EF 0xB8) on raw LAN UDP socket
 * - Dual tracking modes:
 *     1. RAW GYRO (default, DualSense/Steam Deck world-space gyro): ZERO OS fusion filter lag,
 *        ZERO accelerometer whip pull, ZERO vendor ZUPT sticking, instant edge recovery.
 *     2. FUSED (TYPE_GAME_ROTATION_VECTOR): Absolute orientation pointer.
 */
public class MotionEngine implements SensorEventListener {

    public interface Listener {
        void onGesture(String kind, float power);
        void onStats(int hz, boolean udpActive);
        void onBinaryFallback(byte[] frame18);
    }

    private static final double DEG2RAD = Math.PI / 180.0;
    private static final double RAD2DEG = 180.0 / Math.PI;
    private static final double BASE_HALF_FOV_X = 16.5 * DEG2RAD;
    private static final double BASE_HALF_FOV_Y = 13.0 * DEG2RAD;
    private static final double GYRO_DEADZONE_RAD_S = 0.008; // ~0.45 deg/s stationary noise floor

    private final SensorManager sensorManager;
    private final Listener listener;

    private HandlerThread imuThread;
    private Handler imuHandler;
    private boolean running = false;

    // Raw LAN UDP socket (pre-allocated 24-byte buffer -> ZERO GC at 250Hz!)
    private DatagramSocket udpSocket;
    private InetAddress targetAddr;
    private int targetUdpPort = 41234;
    private final byte[] udpBuf = new byte[24];
    private DatagramPacket udpPacket;
    private volatile boolean useLanUdp = true;
    private volatile boolean udpConfirmed = false;
    private volatile long udpProbeStartNs = 0L;
    private long lastUdpProbeNs = 0L;

    // Tracking mode: true = RAW GYRO (zero fusion lag/sticking), false = FUSED (game rotation vector)
    private volatile boolean rawGyroMode = true;

    private volatile byte[] roomBytes = new byte[] { 0, 0, 0, 0 };
    private volatile int playerSlot = 0;
    private volatile boolean btnA = false;
    private volatile boolean btnB = false;
    private volatile float sensitivity = 1.0f;

    // Raw Gyro World-Space state
    private long prevGyroTimestampNs = 0L;
    private double gyroYawRad = 0.0;
    private double gyroPitchRad = 0.0;
    private float gux = 0f, guy = 0f, guz = 1f; // Unit gravity vector (low-passed, immune to whips)
    private boolean hasGravity = false;

    // Fused Orientation basis & calibration
    private final float[] rotMat = new float[9];
    private boolean calibrated = false;
    private boolean hasSample = false;

    private float lrx = 1, lry = 0, lrz = 0;
    private float ltx = 0, lty = 1, ltz = 0;

    private float hfx = 0, hfy = 1;
    private float hrx = 1, hry = 0;
    private float calPitchRad = 0;
    private float rx = 1, ry = 0, rz = 0;
    private float ux = 0, uy = 0, uz = 1;

    // Live linear accel / gyro gesture state
    private volatile float gForce = 0f;
    private volatile float swingPower = 0f;
    private float gx = 0, gy = 0, gz = 0;
    private long lastSlashMs = 0;
    private long lastShakeMs = 0;
    private long shakeWindowMs = 0;
    private int shakeCount = 0;

    // Rate tracking & sequence counter
    private int seq = 0;
    private int sampleCount = 0;
    private int measuredHz = 0;
    private long rateWindowStartNs = 0;
    private long lastEmitNs = 0;

    public MotionEngine(Context ctx, Listener listener) {
        this.sensorManager = (SensorManager) ctx.getSystemService(Context.SENSOR_SERVICE);
        this.listener = listener;
    }

    public boolean isRawGyroMode() {
        return rawGyroMode;
    }

    public void setRawGyroMode(boolean enabled) {
        this.rawGyroMode = enabled;
        this.gyroYawRad = 0.0;
        this.gyroPitchRad = 0.0;
        this.prevGyroTimestampNs = 0L;
        this.calibrated = false;
        this.sampleCount = 0;
        this.rateWindowStartNs = SystemClock.elapsedRealtimeNanos();
    }

    public void configureTarget(String lanHost, int udpPort, String roomCode, int slot, boolean enableUdp) {
        this.playerSlot = slot & 0xFF;
        this.targetUdpPort = udpPort > 0 ? udpPort : 41234;
        this.useLanUdp = enableUdp;
        this.udpConfirmed = false;
        this.udpProbeStartNs = SystemClock.elapsedRealtimeNanos();

        byte[] rb = new byte[] { 0, 0, 0, 0 };
        if (roomCode != null) {
            String clean = roomCode.trim().toUpperCase();
            for (int i = 0; i < Math.min(4, clean.length()); i++) {
                rb[i] = (byte) clean.charAt(i);
            }
        }
        this.roomBytes = rb;

        if (enableUdp && lanHost != null && !lanHost.isEmpty()) {
            new Thread(() -> {
                try {
                    InetAddress addr = InetAddress.getByName(lanHost);
                    if (udpSocket == null || udpSocket.isClosed()) {
                        udpSocket = new DatagramSocket();
                        try {
                            // DSCP EF (0xB8) -> Wi-Fi WMM AC_VO high-priority low-latency queue!
                            udpSocket.setTrafficClass(0xB8);
                        } catch (Exception ignored) {}
                    }
                    targetAddr = addr;
                    udpPacket = new DatagramPacket(udpBuf, 24, addr, targetUdpPort);
                } catch (Exception ignored) {
                    targetAddr = null;
                }
            }, "AeroUdpResolve").start();
        }
    }

    public void markUdpConfirmed() {
        this.udpConfirmed = true;
    }

    public void setButtons(boolean a, boolean b) {
        this.btnA = a;
        this.btnB = b;
    }

    public void setSensitivity(float mult) {
        this.sensitivity = Math.max(0.6f, Math.min(1.8f, mult));
    }

    public void recenter() {
        gyroYawRad = 0.0;
        gyroPitchRad = 0.0;
        if (hasSample) {
            calibrateCurrent();
        } else {
            calibrated = false;
        }
    }

    public void start() {
        if (running || sensorManager == null) return;
        running = true;
        calibrated = false;
        gyroYawRad = 0.0;
        gyroPitchRad = 0.0;
        prevGyroTimestampNs = 0L;
        sampleCount = 0;
        rateWindowStartNs = SystemClock.elapsedRealtimeNanos();
        lastEmitNs = 0;

        imuThread = new HandlerThread("AeroIMU", Process.THREAD_PRIORITY_URGENT_AUDIO);
        imuThread.start();
        imuHandler = new Handler(imuThread.getLooper());

        // 1. Hardware Gyroscope at SENSOR_DELAY_FASTEST with maxReportLatencyUs = 0 (NO FIFO batching!)
        Sensor gyro = sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE);
        if (gyro != null) {
            sensorManager.registerListener(this, gyro, SensorManager.SENSOR_DELAY_FASTEST, 0, imuHandler);
        } else {
            // Device lacks raw gyro -> automatically fall back to Fused
            rawGyroMode = false;
        }

        // 2. Gravity sensor (or Accelerometer fallback) for world-vertical yaw projection + roll
        Sensor grav = sensorManager.getDefaultSensor(Sensor.TYPE_GRAVITY);
        if (grav != null) {
            sensorManager.registerListener(this, grav, SensorManager.SENSOR_DELAY_GAME, 0, imuHandler);
        } else {
            Sensor acc = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
            if (acc != null) {
                sensorManager.registerListener(this, acc, SensorManager.SENSOR_DELAY_GAME, 0, imuHandler);
            }
        }

        // 3. Fused Game Rotation Vector (available for 1-tap FUSED mode toggle)
        Sensor rot = sensorManager.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR);
        if (rot == null) rot = sensorManager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
        if (rot != null) {
            sensorManager.registerListener(this, rot, SensorManager.SENSOR_DELAY_FASTEST, 0, imuHandler);
        }

        // 4. Linear acceleration for crisp Slash & Shake gesture detection
        Sensor linAcc = sensorManager.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION);
        if (linAcc != null) {
            sensorManager.registerListener(this, linAcc, SensorManager.SENSOR_DELAY_GAME, 0, imuHandler);
        }
    }

    public void stop() {
        if (!running) return;
        running = false;
        if (sensorManager != null) {
            sensorManager.unregisterListener(this);
        }
        if (imuThread != null) {
            imuThread.quitSafely();
            imuThread = null;
            imuHandler = null;
        }
        if (udpSocket != null) {
            try { udpSocket.close(); } catch (Exception ignored) {}
            udpSocket = null;
        }
    }

    private void calibrateCurrent() {
        float flen = (float) Math.hypot(Math.hypot(ltx, lty), ltz);
        if (flen < 1e-5f) flen = 1f;
        float fx = ltx / flen;
        float fy = lty / flen;
        float fz = ltz / flen;

        float hlen = (float) Math.hypot(ltx, lty);
        if (hlen >= 0.25f) {
            hfx = ltx / hlen;
            hfy = lty / hlen;
        } else {
            float rlen2 = (float) Math.hypot(lrx, lry);
            if (rlen2 < 1e-5f) rlen2 = 1f;
            float rx2 = lrx / rlen2;
            float ry2 = lry / rlen2;
            hfx = -ry2;
            hfy = rx2;
        }
        hrx = hfy;
        hry = -hfx;
        calPitchRad = (float) Math.asin(clamp(fz, -1f, 1f));

        rx = hrx;
        ry = hry;
        rz = 0f;

        float cux = ry * fz - rz * fy;
        float cuy = rz * fx - rx * fz;
        float cuz = rx * fy - ry * fx;
        float ulen = (float) Math.hypot(Math.hypot(cux, cuy), cuz);
        if (ulen < 1e-5f) ulen = 1f;
        ux = cux / ulen;
        uy = cuy / ulen;
        uz = cuz / ulen;
        calibrated = true;
    }

    private void trackRateAndEmit(double x, double y, double rollRad, double yawDeg, double pitchDeg) {
        long nowNs = SystemClock.elapsedRealtimeNanos();
        sampleCount++;
        long elapsedNs = nowNs - rateWindowStartNs;
        if (elapsedNs >= 750_000_000L) {
            measuredHz = (int) Math.min(255, Math.round((sampleCount * 1_000_000_000.0) / elapsedNs));
            sampleCount = 0;
            rateWindowStartNs = nowNs;
            if (listener != null) {
                listener.onStats(measuredHz, useLanUdp && udpConfirmed && targetAddr != null);
            }
        }

        // Cap cleanly: ~250Hz (3.9ms) over confirmed LAN UDP, ~120Hz (8.2ms) over WS fallback / remote WSS
        boolean fastUdp = useLanUdp && targetAddr != null && (udpConfirmed || (nowNs - udpProbeStartNs < 900_000_000L));
        long minSpacingNs = fastUdp ? 3_900_000L : 8_200_000L;
        if (nowNs - lastEmitNs < minSpacingNs) return;
        lastEmitNs = nowNs;

        emitPacket(x, y, rollRad, yawDeg, pitchDeg, nowNs);
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        if (!running) return;
        int type = event.sensor.getType();

        // Gravity / Accelerometer -> smooth unit world-up vector (immune to fast whip shocks)
        if (type == Sensor.TYPE_GRAVITY || type == Sensor.TYPE_ACCELEROMETER) {
            float ax = event.values[0], ay = event.values[1], az = event.values[2];
            float len = (float) Math.hypot(Math.hypot(ax, ay), az);
            if (len > 4.0f && len < 16.5f) {
                float nx = ax / len, ny = ay / len, nz = az / len;
                if (!hasGravity) {
                    gux = nx; guy = ny; guz = nz;
                    hasGravity = true;
                } else {
                    float a = (type == Sensor.TYPE_GRAVITY) ? 0.16f : 0.05f;
                    gux += (nx - gux) * a;
                    guy += (ny - guy) * a;
                    guz += (nz - guz) * a;
                    float gl = (float) Math.hypot(Math.hypot(gux, guy), guz);
                    if (gl > 1e-4f) {
                        gux /= gl; guy /= gl; guz /= gl;
                    }
                }
            }
            return;
        }

        // 1. RAW GYRO PATH (Default — DualSense / Steam Deck World-Space Gyro, ZERO fusion sticking!)
        if (type == Sensor.TYPE_GYROSCOPE) {
            gx = event.values[0];
            gy = event.values[1];
            gz = event.values[2];
            if (!rawGyroMode) return;

            long ts = event.timestamp;
            if (prevGyroTimestampNs == 0L) {
                prevGyroTimestampNs = ts;
                return;
            }
            double dt = (ts - prevGyroTimestampNs) * 1e-9;
            prevGyroTimestampNs = ts;
            if (dt <= 0.0002 || dt > 0.05) return;

            // World-vertical yaw rate = -(omega dot gravity_unit) -> 1:1 horizontal aim at ANY tilt!
            double yawRate = -(gx * gux + gy * guy + gz * guz);
            double pitchRate = gx;

            if (Math.abs(yawRate) < GYRO_DEADZONE_RAD_S) yawRate = 0.0;
            if (Math.abs(pitchRate) < GYRO_DEADZONE_RAD_S) pitchRate = 0.0;

            double halfFovX = BASE_HALF_FOV_X / sensitivity;
            double halfFovY = BASE_HALF_FOV_Y / sensitivity;

            // Clamp right at screen edge -> moving back from edge responds IMMEDIATELY like a mouse!
            gyroYawRad = clamp(gyroYawRad + yawRate * dt, -halfFovX, halfFovX);
            gyroPitchRad = clamp(gyroPitchRad + pitchRate * dt, -halfFovY, halfFovY);

            double x = clamp(0.5 + gyroYawRad / (2.0 * halfFovX), 0.0, 1.0);
            double y = clamp(0.5 - gyroPitchRad / (2.0 * halfFovY), 0.0, 1.0);
            double rollRad = Math.atan2(-gux, Math.hypot(guy, guz));

            trackRateAndEmit(x, y, rollRad, gyroYawRad * RAD2DEG, gyroPitchRad * RAD2DEG);
            return;
        }

        // 2. FUSED GAME ROTATION VECTOR PATH (Optional 1-tap toggle)
        if (type == Sensor.TYPE_GAME_ROTATION_VECTOR || type == Sensor.TYPE_ROTATION_VECTOR) {
            SensorManager.getRotationMatrixFromVector(rotMat, event.values);
            float prx = rotMat[0], pry = rotMat[3], prz = rotMat[6];
            float ptx = rotMat[1], pty = rotMat[4], ptz = rotMat[7];

            lrx = prx; lry = pry; lrz = prz;
            ltx = ptx; lty = pty; ltz = ptz;
            hasSample = true;

            if (rawGyroMode) return;
            if (!calibrated) calibrateCurrent();

            double hLen = Math.hypot(ptx, pty);
            double yawRad;
            if (hLen >= 0.30) {
                double hx = ptx * hrx + pty * hry;
                double hz = ptx * hfx + pty * hfy;
                yawRad = Math.atan2(hx, hz);
            } else {
                double hx = -(prx * hfx + pry * hfy);
                double hz = prx * hrx + pry * hry;
                yawRad = Math.atan2(hx, hz);
            }

            double pitchRad = Math.asin(clamp(ptz, -1f, 1f)) - calPitchRad;
            double rDotUp = prx * ux + pry * uy + prz * uz;
            double rDotRight = prx * rx + pry * ry + prz * rz;
            double rollRad = Math.atan2(-rDotUp, rDotRight);

            double halfFovX = BASE_HALF_FOV_X / sensitivity;
            double halfFovY = BASE_HALF_FOV_Y / sensitivity;

            double x = clamp(0.5 + yawRad / (2.0 * halfFovX), 0.0, 1.0);
            double y = clamp(0.5 - pitchRad / (2.0 * halfFovY), 0.0, 1.0);

            trackRateAndEmit(x, y, rollRad, yawRad * RAD2DEG, pitchRad * RAD2DEG);
            return;
        }

        // 3. Linear Acceleration Gesture Detector (Slash & Shake)
        if (type == Sensor.TYPE_LINEAR_ACCELERATION) {
            float ax = event.values[0], ay = event.values[1], az = event.values[2];
            float accelMag = (float) Math.hypot(Math.hypot(ax, ay), az);
            float rotDegPerSec = (float) (Math.hypot(Math.hypot(gx, gy), gz) * RAD2DEG);
            float sw = Math.max(accelMag / 14f, rotDegPerSec / 260f);
            gForce = accelMag / 9.81f;
            swingPower = sw;

            if (sw < 1.05f && accelMag < 15f) return;
            long nowMs = SystemClock.elapsedRealtime();

            if (sw > 1.1f && nowMs - lastSlashMs > 180) {
                lastSlashMs = nowMs;
                if (listener != null) listener.onGesture("slash", Math.min(3f, sw));
            }
            if (accelMag > 15.5f) {
                if (nowMs - shakeWindowMs > 380) {
                    shakeWindowMs = nowMs;
                    shakeCount = 1;
                } else {
                    shakeCount++;
                    if (shakeCount >= 3 && nowMs - lastShakeMs > 680) {
                        lastShakeMs = nowMs;
                        shakeCount = 0;
                        if (listener != null) listener.onGesture("shake", Math.min(3f, accelMag / 14f));
                    }
                }
            }
        }
    }

    private void emitPacket(double x, double y, double roll, double yawDeg, double pitchDeg, long nowNs) {
        byte[] rb = this.roomBytes;
        udpBuf[0] = rb[0];
        udpBuf[1] = rb[1];
        udpBuf[2] = rb[2];
        udpBuf[3] = rb[3];

        udpBuf[4] = 0x01; // PKT_MOTION
        udpBuf[5] = (byte) (playerSlot & 0xFF);
        int flags = (btnA ? 1 : 0) | (btnB ? 2 : 0) | 4 | 8; // highRate + nativeUdp
        udpBuf[6] = (byte) flags;
        udpBuf[7] = (byte) Math.min(255, Math.max(1, measuredHz > 0 ? measuredHz : 200));

        putU16LE(udpBuf, 8, (int) Math.round(x * 65535.0));
        putU16LE(udpBuf, 10, (int) Math.round(y * 65535.0));
        putI16LE(udpBuf, 12, (int) Math.round(clamp(roll, -Math.PI, Math.PI) * 10000.0));
        putI16LE(udpBuf, 14, (int) Math.round(clamp(yawDeg, -180.0, 180.0) * 100.0));
        putI16LE(udpBuf, 16, (int) Math.round(clamp(pitchDeg, -180.0, 180.0) * 100.0));
        putU16LE(udpBuf, 18, (int) Math.round(clamp(gForce, 0f, 10f) * 1000.0));
        putU16LE(udpBuf, 20, (int) Math.round(clamp(swingPower, 0f, 10f) * 1000.0));

        seq = (seq + 1) & 0xFFFF;
        putU16LE(udpBuf, 22, seq);

        boolean canUdp = useLanUdp && udpSocket != null && udpPacket != null && targetAddr != null;
        if (canUdp && udpConfirmed) {
            try {
                udpSocket.send(udpPacket);
                return;
            } catch (Exception ignored) {}
        } else if (canUdp) {
            boolean initialProbe = (nowNs - udpProbeStartNs) < 900_000_000L;
            if (initialProbe || (nowNs - lastUdpProbeNs) > 1_000_000_000L) {
                lastUdpProbeNs = nowNs;
                try { udpSocket.send(udpPacket); } catch (Exception ignored) {}
            }
        }

        if (listener != null) {
            byte[] copy = new byte[18];
            System.arraycopy(udpBuf, 4, copy, 0, 18);
            copy[2] = (byte) (copy[2] & ~0x08);
            listener.onBinaryFallback(copy);
        }
    }

    private static void putU16LE(byte[] b, int off, int v) {
        int c = Math.max(0, Math.min(65535, v));
        b[off] = (byte) (c & 0xFF);
        b[off + 1] = (byte) ((c >>> 8) & 0xFF);
    }

    private static void putI16LE(byte[] b, int off, int v) {
        int c = Math.max(-32768, Math.min(32767, v));
        b[off] = (byte) (c & 0xFF);
        b[off + 1] = (byte) ((c >>> 8) & 0xFF);
    }

    private static float clamp(float v, float min, float max) {
        return v < min ? min : Math.min(v, max);
    }

    private static double clamp(double v, double min, double max) {
        return v < min ? min : Math.min(v, max);
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {}
}
