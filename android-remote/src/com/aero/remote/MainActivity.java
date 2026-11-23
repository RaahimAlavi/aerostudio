package com.aero.remote;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

public class MainActivity extends Activity {

    private static final String PREFS = "aero_remote_prefs";
    private static final String[] PALETTE = {
            "#2563EB", "#F43F5E", "#10B981", "#F59E0B",
            "#7C3AED", "#EC4899", "#18181B", "#F8FAFC"
    };
    private static final float[] SENS_VALS = { 0.72f, 1.0f, 1.38f };
    private static final String[] SENS_NAMES = { "LOW", "MED", "HIGH" };

    private final Handler ui = new Handler(Looper.getMainLooper());
    private Vibrator vibrator;
    private MotionEngine motion;
    private SimpleWsClient ws;
    private WifiManager.WifiLock wifiLock;
    private PowerManager.WakeLock wakeLock;

    // Connection params
    private String lanHost = "192.168.18.6";
    private int httpPort = 3000;
    private int udpPort = 41234;
    private String roomCode = "";
    private String remoteOrigin = "";
    private boolean triedRemoteFallback = false;

    // Live player & mode state
    private int playerSlot = 0;
    private int accentColor = Color.parseColor("#2563EB");
    private String currentMode = "hub";
    private int sensIdx = 1;
    private boolean btnAHeld = false;
    private boolean btnBHeld = false;
    private String selectedColor = "#2563EB";
    private String selectedTool = "pen";
    private int selectedSizeIdx = 1;
    private static final float[] SKETCH_SIZES = { 5f, 11f, 20f, 34f };
    private static final String[] SKETCH_SIZE_LABELS = { "S", "M", "L", "XL" };
    private String sketchRole = "none";
    private String sketchSecretWord = "";

    // UI refs
    private TextView tvPlayerBadge;
    private TextView tvHzBadge;
    private TextView tvImuBtn;
    private TextView tvSensBtn;
    private TextView tvModeTitle;
    private TextView tvModeHint;
    private LinearLayout connectCard;
    private EditText etHost;
    private EditText etRoom;
    private TextView btnConnect;
    private TextView tvConnectHint;
    private LinearLayout contextDrawer;
    private LinearLayout btnAView;
    private TextView tvASub;
    private LinearLayout btnBView;
    private TextView tvBLabel;
    private View[] ledViews = new View[4];
    private AlertDialog voteDialog;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);

        SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
        lanHost = sp.getString("host", lanHost);
        httpPort = sp.getInt("port", 3000);
        udpPort = sp.getInt("udp", 41234);
        roomCode = sp.getString("room", "");
        remoteOrigin = sp.getString("origin", "");

        buildUI();
        initEngine();

        if (!handleDeepLink(getIntent())) {
            connectCard.setVisibility(View.VISIBLE);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleDeepLink(intent);
    }

    @Override
    protected void onResume() {
        super.onResume();
        acquireLowLatencyLocks();
        if (motion != null) motion.start();
    }

    @Override
    protected void onPause() {
        super.onPause();
        releaseLowLatencyLocks();
        if (motion != null) motion.stop();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        releaseLowLatencyLocks();
        if (motion != null) motion.stop();
        if (ws != null) ws.close();
    }

    private void acquireLowLatencyLocks() {
        try {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                if (wifiLock == null) {
                    int mode = (Build.VERSION.SDK_INT >= 29)
                            ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                            : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
                    wifiLock = wm.createWifiLock(mode, "AeroRemote:LowLatencyWifi");
                    wifiLock.setReferenceCounted(false);
                }
                if (!wifiLock.isHeld()) wifiLock.acquire();
            }
        } catch (Exception ignored) {}
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                if (wakeLock == null) {
                    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AeroRemote:ImuCpu");
                    wakeLock.setReferenceCounted(false);
                }
                if (!wakeLock.isHeld()) wakeLock.acquire(30 * 60 * 1000L);
            }
        } catch (Exception ignored) {}
    }

    private void releaseLowLatencyLocks() {
        try {
            if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        } catch (Exception ignored) {}
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (Exception ignored) {}
    }

    private boolean handleDeepLink(Intent intent) {
        if (intent == null) return false;
        Uri data = intent.getData();
        if (data == null || !"aero".equalsIgnoreCase(data.getScheme())) return false;

        String h = data.getQueryParameter("host");
        String p = data.getQueryParameter("port");
        String u = data.getQueryParameter("udp");
        String r = data.getQueryParameter("room");
        String o = data.getQueryParameter("origin");

        boolean hasLan = (h != null && !h.isEmpty());
        if (hasLan) lanHost = h;
        if (p != null && !p.isEmpty()) {
            try { httpPort = Integer.parseInt(p); } catch (Exception ignored) {}
        }
        if (u != null && !u.isEmpty()) {
            try { udpPort = Integer.parseInt(u); } catch (Exception ignored) {}
        }
        if (r != null) roomCode = r.trim().toUpperCase();
        if (o != null) remoteOrigin = o;

        etHost.setText(lanHost);
        etRoom.setText(roomCode);
        savePrefs();
        // In Cloud-deployed mode (no LAN IP), jump straight to secure wss:// with zero 2.6s LAN wait!
        boolean directCloud = !hasLan && remoteOrigin != null && remoteOrigin.startsWith("https://");
        if (directCloud) triedRemoteFallback = true;
        connectNow(directCloud);
        return true;
    }

    private void savePrefs() {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .putString("host", lanHost)
                .putInt("port", httpPort)
                .putInt("udp", udpPort)
                .putString("room", roomCode)
                .putString("origin", remoteOrigin)
                .apply();
    }

    private void initEngine() {
        motion = new MotionEngine(this, new MotionEngine.Listener() {
            @Override
            public void onGesture(String kind, float power) {
                try {
                    JSONObject obj = new JSONObject();
                    obj.put("type", "gesture");
                    obj.put("kind", kind);
                    obj.put("power", power);
                    if (ws != null) ws.sendText(obj.toString());
                } catch (Exception ignored) {}
            }

            @Override
            public void onStats(int hz, boolean udpActive) {
                ui.post(() -> {
                    String link = udpActive ? "UDP" : "WS";
                    tvHzBadge.setText(link + " · " + hz + "HZ");
                    tvHzBadge.setBackground(makeRoundedBg(
                            udpActive ? Color.parseColor("#059669") : Color.parseColor("#111318"),
                            dp(12), 0, 0));
                });
            }

            @Override
            public void onBinaryFallback(byte[] frame18) {
                if (ws != null && ws.isOpen()) {
                    ws.sendBinaryLatest(frame18);
                }
            }
        });

        ws = new SimpleWsClient(new SimpleWsClient.Callback() {
            @Override
            public void onOpen() {
                ui.post(() -> {
                    tvPlayerBadge.setText("LINKED");
                    tvConnectHint.setText(triedRemoteFallback
                            ? "Linked via Cloudflare HTTPS (remote mode)"
                            : "Linked on LAN — waiting for 240Hz UDP lock...");
                    connectCard.setVisibility(View.GONE);
                });
            }

            @Override
            public void onText(String text) {
                ui.post(() -> handleServerMessage(text));
            }

            @Override
            public void onClose(String reason) {
                ui.post(() -> {
                    // If direct LAN WS failed and we have a Cloudflare remote origin, seamlessly fall back to WSS!
                    if (!triedRemoteFallback && remoteOrigin != null && remoteOrigin.startsWith("https://")) {
                        triedRemoteFallback = true;
                        tvConnectHint.setText("LAN unreachable (PC Firewall?) — switching to Cloudflare...");
                        connectNow(true);
                        return;
                    }
                    tvPlayerBadge.setText("OFFLINE");
                    String msg = (reason != null && !reason.isEmpty()) ? reason : "Unable to reach PC";
                    tvConnectHint.setText("Offline: " + msg + " · Check PC Firewall & same Wi-Fi");
                    connectCard.setVisibility(View.VISIBLE);
                });
            }
        });
    }

    private void connectNow(boolean useRemoteWss) {
        if (!useRemoteWss) {
            triedRemoteFallback = false;
            lanHost = etHost.getText().toString().trim();
            roomCode = etRoom.getText().toString().trim().toUpperCase();
            savePrefs();
        }

        tvPlayerBadge.setText("LINKING...");
        String qs = "?role=controller&native=1" + (roomCode.isEmpty() ? "" : "&room=" + roomCode);
        String url;
        boolean enableUdp;

        if (useRemoteWss && remoteOrigin != null && remoteOrigin.startsWith("https://")) {
            url = remoteOrigin.replace("https://", "wss://") + "/ws" + qs;
            enableUdp = false;
            tvConnectHint.setText("Connecting via Cloudflare HTTPS...");
        } else {
            url = "ws://" + lanHost + ":" + httpPort + "/ws" + qs;
            enableUdp = true;
            tvConnectHint.setText("Connecting directly to LAN " + lanHost + ":" + httpPort + "...");
        }

        motion.configureTarget(lanHost, udpPort, roomCode, playerSlot, enableUdp);
        motion.start();
        ws.connect(url);
    }

    private void handleServerMessage(String raw) {
        try {
            JSONObject msg = new JSONObject(raw);
            String type = msg.optString("type", "");

            if ("controller_welcome".equals(type)) {
                playerSlot = msg.optInt("slot", 0);
                roomCode = msg.optString("roomCode", roomCode);
                etRoom.setText(roomCode);
                JSONObject prof = msg.optJSONObject("profile");
                if (prof != null) {
                    String hex = prof.optString("color", "#2563EB");
                    selectedColor = hex;
                    accentColor = Color.parseColor(hex);
                    String lbl = prof.optString("label", "P" + (playerSlot + 1));
                    tvPlayerBadge.setText(lbl + " · " + roomCode);
                }
                int serverUdp = msg.optInt("udpPort", udpPort);
                udpPort = serverUdp;
                motion.configureTarget(lanHost, udpPort, roomCode, playerSlot, !triedRemoteFallback);
                motion.recenter();
                updatePlayerAccent();
                applyMode(msg.optString("mode", "hub"));
                vibrateMs(24);
            } else if ("udp_confirmed".equals(type)) {
                motion.markUdpConfirmed();
                tvConnectHint.setText("Direct 240Hz LAN UDP locked (0ms queue)");
            } else if ("mode".equals(type)) {
                applyMode(msg.optString("mode", "hub"));
                vibrateMs(14);
            } else if ("feedback".equals(type)) {
                JSONArray vib = msg.optJSONArray("vibrate");
                if (vib != null && vib.length() > 0) {
                    vibrateMs(Math.max(10, Math.min(140, vib.optInt(0, 18))));
                } else {
                    vibrateMs(16);
                }
            } else if ("to_controller".equals(type)) {
                String kind = msg.optString("kind", "");
                if ("clear_vote_prompt".equals(kind)) {
                    showClearVoteDialog(msg.optString("requester", "A friend"));
                } else if ("clear_vote_closed".equals(kind)) {
                    if (voteDialog != null && voteDialog.isShowing()) voteDialog.dismiss();
                } else if ("sketch_role".equals(kind)) {
                    sketchRole = msg.optString("role", "none");
                    sketchSecretWord = msg.optString("word", "");
                    if ("sketch".equals(currentMode)) rebuildContextDrawer();
                }
            }
        } catch (Exception ignored) {}
    }

    private void showClearVoteDialog(String requester) {
        vibrateMs(30);
        if (voteDialog != null && voteDialog.isShowing()) voteDialog.dismiss();
        voteDialog = new AlertDialog.Builder(this)
                .setTitle("Clear 3D Canvas?")
                .setMessage(requester + " wants to reset the 3D sculpture.")
                .setPositiveButton("Agree to Clear", (d, w) -> sendSimpleJson("clear_vote_reply", "approved", true))
                .setNegativeButton("Keep Art", (d, w) -> sendSimpleJson("clear_vote_reply", "approved", false))
                .create();
        voteDialog.show();
    }

    private void applyMode(String mode) {
        currentMode = mode == null ? "hub" : mode;
        switch (currentMode) {
            case "blade":
                tvModeTitle.setText("BLADE ARENA");
                tvModeHint.setText("WHIP TO SLICE · 3 LIVES · DODGE MINES");
                tvASub.setText("POWER SLASH");
                tvBLabel.setText("SLOW-MO");
                break;
            case "sculpt":
                tvModeTitle.setText("SCULPT 3D");
                tvModeHint.setText("HOLD A TO SCULPT · HOLD B TO ORBIT");
                tvASub.setText("SCULPT");
                tvBLabel.setText("ORBIT SPIN");
                break;
            case "strike":
                tvModeTitle.setText("STRIKE TABLE");
                tvModeHint.setText("DEFEND GOAL · TAP A FOR POWER SMASH");
                tvASub.setText("SMASH");
                tvBLabel.setText("BOOST");
                break;
            case "sketch":
                tvModeTitle.setText("AIR SKETCH");
                tvModeHint.setText("HOLD A TO DRAW · PICK TOOLS ABOVE");
                tvASub.setText("DRAW / FILL");
                tvBLabel.setText("UNDO");
                break;
            default:
                tvModeTitle.setText("AERO STUDIO");
                tvModeHint.setText("POINT AT SCREEN · TAP A TO ENTER");
                tvASub.setText("SELECT");
                tvBLabel.setText("BOOST");
                break;
        }
        rebuildContextDrawer();
    }

    private void rebuildContextDrawer() {
        contextDrawer.removeAllViews();
        if (!"sculpt".equals(currentMode) && !"sketch".equals(currentMode)) {
            contextDrawer.setVisibility(View.GONE);
            return;
        }
        contextDrawer.setVisibility(View.VISIBLE);

        if ("sketch".equals(currentMode) && "guesser".equals(sketchRole)) {
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);

            EditText input = new EditText(this);
            input.setHint("Type your guess...");
            input.setSingleLine(true);
            input.setTextColor(Color.parseColor("#111318"));
            input.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
            input.setPadding(dp(12), dp(8), dp(12), dp(8));
            input.setBackground(makeRoundedBg(Color.parseColor("#F3F4F6"), dp(10), Color.parseColor("#D1D5DB"), dp(1)));
            row.addView(input, new LinearLayout.LayoutParams(0, dp(42), 1f));

            TextView sendBtn = makeChip("Send", Color.parseColor("#111318"), Color.WHITE);
            LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(42));
            sp.leftMargin = dp(8);
            sendBtn.setOnClickListener(v -> {
                String g = input.getText().toString().trim();
                if (g.isEmpty()) return;
                sendSimpleJson("sketch_guess", "text", g);
                input.setText("");
                vibrateMs(14);
            });
            row.addView(sendBtn, sp);
            contextDrawer.addView(row);
            return;
        }

        // Artist Secret Word banner in Air Sketch
        if ("sketch".equals(currentMode) && sketchSecretWord != null && !sketchSecretWord.isEmpty()) {
            TextView secret = new TextView(this);
            secret.setText("SECRET WORD:  " + sketchSecretWord);
            secret.setTextColor(Color.WHITE);
            secret.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
            secret.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            secret.setGravity(Gravity.CENTER);
            secret.setPadding(dp(12), dp(8), dp(12), dp(8));
            secret.setBackground(makeRoundedBg(Color.parseColor("#111318"), dp(10), 0, 0));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.bottomMargin = dp(8);
            contextDrawer.addView(secret, lp);
        }

        // Color swatches row
        LinearLayout swatchRow = new LinearLayout(this);
        swatchRow.setOrientation(LinearLayout.HORIZONTAL);
        swatchRow.setGravity(Gravity.CENTER);
        int count = "sketch".equals(currentMode) ? 7 : PALETTE.length;
        for (int i = 0; i < count; i++) {
            final String hex = PALETTE[i];
            View dot = new View(this);
            boolean active = hex.equalsIgnoreCase(selectedColor) && !"erase".equals(selectedTool);
            dot.setBackground(makeCircleBg(Color.parseColor(hex), active ? Color.parseColor("#111318") : Color.parseColor("#D1D5DB"), active ? dp(3) : dp(1)));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(28), dp(28));
            lp.setMargins(dp(4), 0, dp(4), 0);
            dot.setOnClickListener(v -> {
                selectedColor = hex;
                if ("erase".equals(selectedTool)) selectedTool = "sculpt".equals(currentMode) ? "sculpt" : "pen";
                sendToolUpdate("color", hex, "tool", selectedTool);
                vibrateMs(10);
                rebuildContextDrawer();
            });
            swatchRow.addView(dot, lp);
        }
        LinearLayout.LayoutParams srp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        srp.bottomMargin = dp(8);
        contextDrawer.addView(swatchRow, srp);

        // Tools row
        LinearLayout toolsRow = new LinearLayout(this);
        toolsRow.setOrientation(LinearLayout.HORIZONTAL);
        if ("sculpt".equals(currentMode)) {
            addToolBtn(toolsRow, "Sculpt", !"erase".equals(selectedTool), () -> {
                selectedTool = "sculpt";
                sendToolUpdate("tool", "sculpt", null, null);
                rebuildContextDrawer();
            });
            addToolBtn(toolsRow, "Eraser", "erase".equals(selectedTool), () -> {
                selectedTool = "erase";
                sendToolUpdate("tool", "erase", null, null);
                rebuildContextDrawer();
            });
            addToolBtn(toolsRow, "Undo", false, () -> sendToolUpdate("cmd", "undo", null, null));
            addToolBtn(toolsRow, "Clear", false, () -> sendToolUpdate("cmd", "clear", null, null));
        } else {
            addToolBtn(toolsRow, "Pen", "pen".equals(selectedTool), () -> {
                selectedTool = "pen";
                sendToolUpdate("tool", "pen", null, null);
                rebuildContextDrawer();
            });
            addToolBtn(toolsRow, "Brush", "brush".equals(selectedTool), () -> {
                selectedTool = "brush";
                sendToolUpdate("tool", "brush", null, null);
                rebuildContextDrawer();
            });
            addToolBtn(toolsRow, "Fill", "fill".equals(selectedTool), () -> {
                selectedTool = "fill";
                sendToolUpdate("tool", "fill", null, null);
                rebuildContextDrawer();
            });
            addToolBtn(toolsRow, "Eraser", "erase".equals(selectedTool), () -> {
                selectedTool = "erase";
                sendToolUpdate("tool", "erase", null, null);
                rebuildContextDrawer();
            });
            addToolBtn(toolsRow, "Undo", false, () -> sendToolUpdate("cmd", "undo", null, null));
        }
        contextDrawer.addView(toolsRow);

        // Air Sketch stroke width row (S / M / L / XL)
        if ("sketch".equals(currentMode)) {
            LinearLayout sizeRow = new LinearLayout(this);
            sizeRow.setOrientation(LinearLayout.HORIZONTAL);
            sizeRow.setGravity(Gravity.CENTER);
            for (int i = 0; i < SKETCH_SIZES.length; i++) {
                final int idx = i;
                boolean active = (selectedSizeIdx == idx);
                TextView btn = makeChip(
                        SKETCH_SIZE_LABELS[idx],
                        active ? Color.parseColor("#111318") : Color.parseColor("#F3F4F6"),
                        active ? Color.WHITE : Color.parseColor("#111318")
                );
                LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(0, dp(30), 1f);
                slp.setMargins(dp(3), dp(6), dp(3), 0);
                btn.setOnClickListener(v -> {
                    selectedSizeIdx = idx;
                    try {
                        JSONObject obj = new JSONObject();
                        obj.put("type", "sketch_tool");
                        obj.put("size", SKETCH_SIZES[idx]);
                        if (ws != null) ws.sendText(obj.toString());
                    } catch (Exception ignored) {}
                    vibrateMs(8);
                    rebuildContextDrawer();
                });
                sizeRow.addView(btn, slp);
            }
            contextDrawer.addView(sizeRow);
        }
    }

    private void addToolBtn(LinearLayout row, String label, boolean active, Runnable action) {
        TextView tv = makeChip(label, active ? Color.parseColor("#111318") : Color.parseColor("#EAECEF"),
                active ? Color.WHITE : Color.parseColor("#111318"));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, dp(34), 1f);
        lp.setMargins(dp(3), 0, dp(3), 0);
        tv.setOnClickListener(v -> {
            vibrateMs(10);
            action.run();
        });
        row.addView(tv, lp);
    }

    private void sendToolUpdate(String k1, String v1, String k2, String v2) {
        try {
            JSONObject obj = new JSONObject();
            obj.put("type", "sketch".equals(currentMode) ? "sketch_tool" : "sculpt_tool");
            if (k1 != null) obj.put(k1, v1);
            if (k2 != null) obj.put(k2, v2);
            if (ws != null) ws.sendText(obj.toString());
        } catch (Exception ignored) {}
    }

    private void sendSimpleJson(String type, String key, Object val) {
        try {
            JSONObject obj = new JSONObject();
            obj.put("type", type);
            if (key != null) obj.put(key, val);
            if (ws != null) ws.sendText(obj.toString());
        } catch (Exception ignored) {}
    }

    private void sendAction(String name) {
        sendSimpleJson("action", "name", name);
    }

    private void updatePlayerAccent() {
        btnAView.setBackground(makeCircleBg(Color.WHITE, accentColor, dp(3)));
        tvASub.setTextColor(accentColor);
        for (int i = 0; i < 4; i++) {
            ledViews[i].setBackground(makeRoundedBg(
                    i == playerSlot ? accentColor : Color.parseColor("#D5DAE3"), dp(3), 0, 0));
        }
    }

    private void vibrateMs(int ms) {
        if (vibrator == null) return;
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                vibrator.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE));
            } else {
                vibrator.vibrate(ms);
            }
        } catch (Exception ignored) {}
    }

    // =========================================================================
    // MINIMAL CERAMIC STUDIO NATIVE UI CONSTRUCTION
    // =========================================================================
    private void buildUI() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setFitsSystemWindows(true);
        root.setBackgroundColor(Color.parseColor("#F3F4F6"));
        root.setPadding(dp(18), dp(14), dp(18), dp(14));

        // 1. Top Status Strip
        LinearLayout topBar = new LinearLayout(this);
        topBar.setOrientation(LinearLayout.HORIZONTAL);
        topBar.setGravity(Gravity.CENTER_VERTICAL);

        tvPlayerBadge = makeChip("OFFLINE", Color.WHITE, Color.parseColor("#111318"));
        tvPlayerBadge.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        tvPlayerBadge.setOnClickListener(v ->
                connectCard.setVisibility(connectCard.getVisibility() == View.VISIBLE ? View.GONE : View.VISIBLE));
        topBar.addView(tvPlayerBadge);

        View spacer = new View(this);
        topBar.addView(spacer, new LinearLayout.LayoutParams(0, 1, 1f));

        tvImuBtn = makeChip("GYRO", Color.WHITE, Color.parseColor("#111318"));
        tvImuBtn.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        tvImuBtn.setPadding(dp(9), dp(6), dp(9), dp(6));
        tvImuBtn.setOnClickListener(v -> {
            boolean nextRaw = !motion.isRawGyroMode();
            motion.setRawGyroMode(nextRaw);
            tvImuBtn.setText(nextRaw ? "GYRO" : "FUSED");
            vibrateMs(12);
            sendAction("recenter");
        });
        LinearLayout.LayoutParams imuLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(34));
        imuLp.rightMargin = dp(5);
        topBar.addView(tvImuBtn, imuLp);

        tvSensBtn = makeChip("MED", Color.WHITE, Color.parseColor("#111318"));
        tvSensBtn.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        tvSensBtn.setPadding(dp(9), dp(6), dp(9), dp(6));
        tvSensBtn.setOnClickListener(v -> {
            sensIdx = (sensIdx + 1) % SENS_VALS.length;
            motion.setSensitivity(SENS_VALS[sensIdx]);
            tvSensBtn.setText(SENS_NAMES[sensIdx]);
            vibrateMs(10);
        });
        LinearLayout.LayoutParams sensLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(34));
        sensLp.rightMargin = dp(5);
        topBar.addView(tvSensBtn, sensLp);

        tvHzBadge = makeChip("UDP · --HZ", Color.parseColor("#111318"), Color.WHITE);
        tvHzBadge.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        tvHzBadge.setPadding(dp(10), dp(6), dp(10), dp(6));
        topBar.addView(tvHzBadge, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(34)));

        root.addView(topBar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        // 2. Collapsible Quick-Connect Card (auto-hides once linked!)
        connectCard = new LinearLayout(this);
        connectCard.setOrientation(LinearLayout.VERTICAL);
        connectCard.setPadding(dp(12), dp(12), dp(12), dp(10));
        connectCard.setBackground(makeRoundedBg(Color.WHITE, dp(16), Color.parseColor("#E5E7EB"), dp(1)));
        LinearLayout.LayoutParams ccLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        ccLp.topMargin = dp(10);

        LinearLayout inputRow = new LinearLayout(this);
        inputRow.setOrientation(LinearLayout.HORIZONTAL);
        inputRow.setGravity(Gravity.CENTER_VERTICAL);

        etHost = new EditText(this);
        etHost.setText(lanHost);
        etHost.setHint("PC LAN IP");
        etHost.setSingleLine(true);
        etHost.setTextColor(Color.parseColor("#111318"));
        etHost.setHintTextColor(Color.parseColor("#9CA3AF"));
        etHost.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        etHost.setTypeface(Typeface.MONOSPACE);
        etHost.setPadding(dp(10), dp(8), dp(10), dp(8));
        etHost.setBackground(makeRoundedBg(Color.parseColor("#F3F4F6"), dp(10), Color.parseColor("#E5E7EB"), dp(1)));
        LinearLayout.LayoutParams hostLp = new LinearLayout.LayoutParams(0, dp(40), 1.45f);
        hostLp.rightMargin = dp(6);
        inputRow.addView(etHost, hostLp);

        etRoom = new EditText(this);
        etRoom.setText(roomCode);
        etRoom.setHint("ROOM");
        etRoom.setSingleLine(true);
        etRoom.setGravity(Gravity.CENTER);
        etRoom.setInputType(InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS);
        etRoom.setTextColor(Color.parseColor("#111318"));
        etRoom.setHintTextColor(Color.parseColor("#9CA3AF"));
        etRoom.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        etRoom.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        etRoom.setPadding(dp(8), dp(8), dp(8), dp(8));
        etRoom.setBackground(makeRoundedBg(Color.parseColor("#F3F4F6"), dp(10), Color.parseColor("#E5E7EB"), dp(1)));
        LinearLayout.LayoutParams roomLp = new LinearLayout.LayoutParams(0, dp(40), 0.78f);
        roomLp.rightMargin = dp(6);
        inputRow.addView(etRoom, roomLp);

        btnConnect = makeChip("Link", Color.parseColor("#111318"), Color.WHITE);
        btnConnect.setOnClickListener(v -> {
            vibrateMs(16);
            connectNow(false);
        });
        inputRow.addView(btnConnect, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(40)));
        connectCard.addView(inputRow, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        tvConnectHint = new TextView(this);
        tvConnectHint.setText("Enter room code from PC screen or scan QR → Open in App");
        tvConnectHint.setTextColor(Color.parseColor("#646B7A"));
        tvConnectHint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        LinearLayout.LayoutParams hintLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        hintLp.topMargin = dp(7);
        connectCard.addView(tvConnectHint, hintLp);

        root.addView(connectCard, ccLp);

        // 3. Mode Header Card
        LinearLayout modeCard = new LinearLayout(this);
        modeCard.setOrientation(LinearLayout.VERTICAL);
        modeCard.setPadding(dp(16), dp(12), dp(16), dp(12));
        modeCard.setBackground(makeRoundedBg(Color.WHITE, dp(16), Color.parseColor("#E5E7EB"), dp(1)));
        LinearLayout.LayoutParams mcLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        mcLp.topMargin = dp(10);

        tvModeTitle = new TextView(this);
        tvModeTitle.setText("AERO STUDIO");
        tvModeTitle.setTextColor(Color.parseColor("#111318"));
        tvModeTitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        tvModeTitle.setTypeface(Typeface.SANS_SERIF, Typeface.BOLD);

        tvModeHint = new TextView(this);
        tvModeHint.setText("POINT AT SCREEN · TAP A TO ENTER");
        tvModeHint.setTextColor(Color.parseColor("#646B7A"));
        tvModeHint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);

        modeCard.addView(tvModeTitle);
        modeCard.addView(tvModeHint);
        root.addView(modeCard, mcLp);

        // 4. Dynamic Context Drawer (Sculpt 3D / Air Sketch)
        contextDrawer = new LinearLayout(this);
        contextDrawer.setOrientation(LinearLayout.VERTICAL);
        contextDrawer.setPadding(dp(12), dp(10), dp(12), dp(10));
        contextDrawer.setBackground(makeRoundedBg(Color.WHITE, dp(16), Color.parseColor("#E5E7EB"), dp(1)));
        contextDrawer.setVisibility(View.GONE);
        LinearLayout.LayoutParams cdLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        cdLp.topMargin = dp(10);
        root.addView(contextDrawer, cdLp);

        // 5. Center Giant Tactile Circular "A" Button inside Ceramic Bezel
        LinearLayout centerZone = new LinearLayout(this);
        centerZone.setOrientation(LinearLayout.VERTICAL);
        centerZone.setGravity(Gravity.CENTER);

        LinearLayout btnABezel = new LinearLayout(this);
        btnABezel.setOrientation(LinearLayout.VERTICAL);
        btnABezel.setGravity(Gravity.CENTER);
        btnABezel.setPadding(dp(10), dp(10), dp(10), dp(10));
        btnABezel.setBackground(makeCircleBg(Color.parseColor("#EAECEF"), Color.parseColor("#E2E5EC"), dp(1)));

        btnAView = new LinearLayout(this);
        btnAView.setOrientation(LinearLayout.VERTICAL);
        btnAView.setGravity(Gravity.CENTER);
        btnAView.setElevation(dp(8));
        btnAView.setBackground(makeCircleBg(Color.WHITE, accentColor, dp(3)));

        TextView tvALetter = new TextView(this);
        tvALetter.setText("A");
        tvALetter.setGravity(Gravity.CENTER);
        tvALetter.setIncludeFontPadding(false);
        tvALetter.setTextColor(Color.parseColor("#111318"));
        tvALetter.setTextSize(TypedValue.COMPLEX_UNIT_SP, 48);
        tvALetter.setTypeface(Typeface.SANS_SERIF, Typeface.BOLD);

        tvASub = new TextView(this);
        tvASub.setText("SELECT");
        tvASub.setGravity(Gravity.CENTER);
        tvASub.setLetterSpacing(0.1f);
        tvASub.setTextColor(accentColor);
        tvASub.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        tvASub.setTypeface(Typeface.SANS_SERIF, Typeface.BOLD);

        LinearLayout.LayoutParams wrapCenter = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        wrapCenter.gravity = Gravity.CENTER_HORIZONTAL;
        btnAView.addView(tvALetter, wrapCenter);

        LinearLayout.LayoutParams subLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        subLp.gravity = Gravity.CENTER_HORIZONTAL;
        subLp.topMargin = dp(4);
        btnAView.addView(tvASub, subLp);

        btnAView.setOnTouchListener((v, ev) -> {
            int act = ev.getActionMasked();
            if (act == MotionEvent.ACTION_DOWN) {
                btnAHeld = true;
                motion.setButtons(btnAHeld, btnBHeld);
                v.animate().scaleX(0.92f).scaleY(0.92f).setDuration(60).start();
                btnAView.setBackground(makeCircleBg(accentColor, accentColor, dp(3)));
                tvALetter.setTextColor(Color.WHITE);
                tvASub.setTextColor(Color.WHITE);
                vibrateMs(14);
                sendAction("btn_a_down");
                return true;
            } else if (act == MotionEvent.ACTION_UP || act == MotionEvent.ACTION_CANCEL) {
                btnAHeld = false;
                motion.setButtons(btnAHeld, btnBHeld);
                v.animate().scaleX(1f).scaleY(1f).setDuration(90).start();
                btnAView.setBackground(makeCircleBg(Color.WHITE, accentColor, dp(3)));
                tvALetter.setTextColor(Color.parseColor("#111318"));
                tvASub.setTextColor(accentColor);
                sendAction("btn_a_up");
                return true;
            }
            return false;
        });

        btnABezel.addView(btnAView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        centerZone.addView(btnABezel, new LinearLayout.LayoutParams(dp(194), dp(194)));
        root.addView(centerZone, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        // 6. Wide Ergonomic "B" Trigger Bar
        btnBView = new LinearLayout(this);
        btnBView.setOrientation(LinearLayout.HORIZONTAL);
        btnBView.setGravity(Gravity.CENTER_VERTICAL);
        btnBView.setPadding(dp(20), 0, dp(20), 0);
        btnBView.setElevation(dp(3));
        btnBView.setBackground(makeRoundedBg(Color.WHITE, dp(18), Color.parseColor("#E5E7EB"), dp(1)));

        TextView tvBBadge = makeChip("B", Color.parseColor("#EAECEF"), Color.parseColor("#111318"));
        tvBBadge.setTypeface(Typeface.SANS_SERIF, Typeface.BOLD);
        btnBView.addView(tvBBadge);

        tvBLabel = new TextView(this);
        tvBLabel.setText("BOOST");
        tvBLabel.setTextColor(Color.parseColor("#111318"));
        tvBLabel.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        tvBLabel.setTypeface(Typeface.SANS_SERIF, Typeface.BOLD);
        LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        blp.leftMargin = dp(12);
        btnBView.addView(tvBLabel, blp);

        btnBView.setOnTouchListener((v, ev) -> {
            int act = ev.getActionMasked();
            if (act == MotionEvent.ACTION_DOWN) {
                btnBHeld = true;
                motion.setButtons(btnAHeld, btnBHeld);
                v.animate().scaleX(0.96f).scaleY(0.96f).setDuration(60).start();
                btnBView.setBackground(makeRoundedBg(Color.parseColor("#111318"), dp(18), 0, 0));
                tvBLabel.setTextColor(Color.WHITE);
                vibrateMs(14);
                sendAction("btn_b_down");
                return true;
            } else if (act == MotionEvent.ACTION_UP || act == MotionEvent.ACTION_CANCEL) {
                btnBHeld = false;
                motion.setButtons(btnAHeld, btnBHeld);
                v.animate().scaleX(1f).scaleY(1f).setDuration(90).start();
                btnBView.setBackground(makeRoundedBg(Color.WHITE, dp(18), Color.parseColor("#E5E7EB"), dp(1)));
                tvBLabel.setTextColor(Color.parseColor("#111318"));
                sendAction("btn_b_up");
                return true;
            }
            return false;
        });

        LinearLayout.LayoutParams bBarLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(64));
        bBarLp.bottomMargin = dp(10);
        root.addView(btnBView, bBarLp);

        // 7. Utility Row (Recenter + Studio)
        LinearLayout utilRow = new LinearLayout(this);
        utilRow.setOrientation(LinearLayout.HORIZONTAL);

        TextView btnRecenter = makeChip("RECENTER", Color.WHITE, Color.parseColor("#111318"));
        btnRecenter.setOnClickListener(v -> {
            motion.recenter();
            vibrateMs(18);
            sendAction("recenter");
        });
        LinearLayout.LayoutParams rl = new LinearLayout.LayoutParams(0, dp(48), 1.4f);
        rl.rightMargin = dp(8);
        utilRow.addView(btnRecenter, rl);

        TextView btnHome = makeChip("STUDIO", Color.WHITE, Color.parseColor("#111318"));
        btnHome.setOnClickListener(v -> {
            vibrateMs(18);
            sendAction("home");
        });
        utilRow.addView(btnHome, new LinearLayout.LayoutParams(0, dp(48), 1f));

        LinearLayout.LayoutParams urLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        urLp.bottomMargin = dp(12);
        root.addView(utilRow, urLp);

        // 8. 4 Physical Player LEDs
        LinearLayout ledStrip = new LinearLayout(this);
        ledStrip.setOrientation(LinearLayout.HORIZONTAL);
        ledStrip.setGravity(Gravity.CENTER);
        for (int i = 0; i < 4; i++) {
            View led = new View(this);
            led.setBackground(makeRoundedBg(Color.parseColor("#D5DAE3"), dp(3), 0, 0));
            LinearLayout.LayoutParams llp = new LinearLayout.LayoutParams(dp(10), dp(10));
            llp.setMargins(dp(9), 0, dp(9), 0);
            ledStrip.addView(led, llp);
            ledViews[i] = led;
        }
        root.addView(ledStrip);

        setContentView(root);
    }

    private TextView makeChip(String text, int bgColor, int textColor) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextColor(textColor);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        tv.setTypeface(Typeface.SANS_SERIF, Typeface.BOLD);
        tv.setGravity(Gravity.CENTER);
        tv.setPadding(dp(13), dp(6), dp(13), dp(6));
        tv.setBackground(makeRoundedBg(bgColor, dp(12), Color.parseColor("#E5E7EB"), dp(1)));
        return tv;
    }

    private GradientDrawable makeRoundedBg(int fill, int radius, int stroke, int strokeW) {
        GradientDrawable d = new GradientDrawable();
        d.setShape(GradientDrawable.RECTANGLE);
        d.setCornerRadius(radius);
        d.setColor(fill);
        if (strokeW > 0 && stroke != 0) d.setStroke(strokeW, stroke);
        return d;
    }

    private GradientDrawable makeCircleBg(int fill, int stroke, int strokeW) {
        GradientDrawable d = new GradientDrawable();
        d.setShape(GradientDrawable.OVAL);
        d.setColor(fill);
        if (strokeW > 0 && stroke != 0) d.setStroke(strokeW, stroke);
        return d;
    }

    private int dp(int v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }
}
