package nl.vibe.player;

import android.Manifest;
import android.app.Activity;
import android.content.ContentUris;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.media.MediaMetadataRetriever;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import android.view.View;
import android.view.Window;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "Vibe", permissions = {
        @Permission(alias = "audio", strings = { Manifest.permission.READ_MEDIA_AUDIO }),
        @Permission(alias = "legacy", strings = { Manifest.permission.READ_EXTERNAL_STORAGE }),
        @Permission(alias = "notif", strings = { Manifest.permission.POST_NOTIFICATIONS })
})
public class VibePlugin extends Plugin {
    static final HashMap<String, PlayerService.Track> LIBRARY = new HashMap<>();
    private static final String[] EXT = { ".mp3", ".flac", ".wav", ".ogg", ".m4a", ".aac", ".opus" };

    @Override public void load() {
        PlayerService.listener = (playing, index, pos, dur, qid) -> {
            JSObject o = new JSObject();
            o.put("playing", playing);
            o.put("index", index);
            o.put("position", pos);
            o.put("duration", dur);
            o.put("qid", qid);
            notifyListeners("state", o);
        };
    }

    // ---------- rechten ----------

    private String mediaAlias() {
        return Build.VERSION.SDK_INT >= 33 ? "audio" : "legacy";
    }

    private JSObject accessInfo() {
        boolean media = getPermissionState(mediaAlias()) == PermissionState.GRANTED;
        boolean files = Build.VERSION.SDK_INT >= 30 ? Environment.isExternalStorageManager() : media;
        JSObject o = new JSObject();
        o.put("media", media);
        o.put("files", files);
        return o;
    }

    @PluginMethod
    public void access(PluginCall call) {
        String[] aliases = Build.VERSION.SDK_INT >= 33 ? new String[] { "audio", "notif" } : new String[] { "legacy" };
        boolean all = true;
        for (String a : aliases) {
            if (getPermissionState(a) != PermissionState.GRANTED) all = false;
        }
        if (all) {
            call.resolve(accessInfo());
            return;
        }
        requestPermissionForAliases(aliases, call, "accessDone");
    }

    @PermissionCallback
    private void accessDone(PluginCall call) {
        call.resolve(accessInfo());
    }

    @PluginMethod
    public void accessStatus(PluginCall call) {
        call.resolve(accessInfo());
    }

    @PluginMethod
    public void requestFiles(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 30 && !Environment.isExternalStorageManager()) {
            try {
                Intent i = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                        Uri.parse("package:" + getContext().getPackageName()));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
            } catch (Exception e) {
                Intent i = new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
            }
        }
        call.resolve();
    }

    // ---------- bibliotheek ----------

    private static String esc(String s) {
        return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
    }

    private static String clean(String s) {
        return s == null || s.equals("<unknown>") ? "" : s;
    }

    @PluginMethod
    public void scan(PluginCall call) {
        String rel = call.getString("rel", "");
        Uri base = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
        String[] proj = {
                MediaStore.Audio.Media._ID, MediaStore.Audio.Media.TITLE, MediaStore.Audio.Media.ARTIST,
                MediaStore.Audio.Media.ALBUM, MediaStore.Audio.Media.DURATION, MediaStore.Audio.Media.DATA
        };
        String sel = MediaStore.Audio.Media.IS_RINGTONE + "=0 AND " + MediaStore.Audio.Media.IS_NOTIFICATION
                + "=0 AND " + MediaStore.Audio.Media.IS_ALARM + "=0 AND " + MediaStore.Audio.Media.DURATION + ">0";
        String[] args = null;
        if (!rel.isEmpty()) {
            sel += " AND " + MediaStore.Audio.Media.DATA + " LIKE ? ESCAPE '\\'";
            args = new String[] { "%/" + esc(rel) + "/%" };
        }
        JSArray arr = new JSArray();
        HashMap<String, PlayerService.Track> fresh = new HashMap<>();
        try (Cursor c = getContext().getContentResolver().query(base, proj, sel, args, null)) {
            while (c != null && c.moveToNext()) {
                PlayerService.Track t = new PlayerService.Track();
                t.uri = ContentUris.withAppendedId(base, c.getLong(0)).toString();
                t.path = c.getString(5);
                if (t.path == null) continue;
                String title = c.getString(1);
                t.title = title == null || title.isEmpty() ? new File(t.path).getName() : title;
                t.artist = clean(c.getString(2));
                t.album = clean(c.getString(3));
                t.duration = c.getLong(4) / 1000.0;
                fresh.put(t.path, t);
                JSObject o = new JSObject();
                o.put("path", t.path);
                o.put("url", t.uri);
                o.put("title", t.title);
                o.put("artist", t.artist);
                o.put("album", t.album);
                o.put("duration", t.duration);
                arr.put(o);
            }
        } catch (Exception e) {
            JSObject o = new JSObject();
            o.put("tracks", new JSArray());
            o.put("denied", true);
            call.resolve(o);
            return;
        }
        synchronized (LIBRARY) {
            LIBRARY.clear();
            LIBRARY.putAll(fresh);
        }
        JSObject res = new JSObject();
        res.put("tracks", arr);
        call.resolve(res);
    }

    private void walk(File dir, ArrayList<String> out, int depth) {
        File[] fs = dir.listFiles();
        if (fs == null || depth > 10 || out.size() > 30000) return;
        for (File f : fs) {
            if (f.isDirectory()) {
                walk(f, out, depth + 1);
            } else {
                String n = f.getName().toLowerCase();
                for (String e : EXT) {
                    if (n.endsWith(e)) {
                        String p = f.getAbsolutePath();
                        if (!LIBRARY.containsKey(p)) out.add(p);
                        break;
                    }
                }
            }
        }
    }

    /** Laat Android nieuwe bestanden in de gekozen map zien (bijvoorbeeld net gesynchroniseerd). */
    @PluginMethod
    public void refreshMedia(final PluginCall call) {
        ArrayList<String> files = new ArrayList<>();
        try {
            walk(new File(call.getString("abs", "")), files, 0);
        } catch (Exception ignored) { }
        final JSObject res = new JSObject();
        res.put("added", files.size());
        if (files.isEmpty()) {
            call.resolve(res);
            return;
        }
        final int total = files.size();
        final int[] done = { 0 };
        final AtomicBoolean finished = new AtomicBoolean(false);
        MediaScannerConnection.scanFile(getContext(), files.toArray(new String[0]), null, (p, u) -> {
            boolean last;
            synchronized (done) {
                done[0]++;
                last = done[0] >= total;
            }
            if (last && finished.compareAndSet(false, true)) call.resolve(res);
        });
        new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
            if (finished.compareAndSet(false, true)) call.resolve(res);
        }, 20000);
    }

    @PluginMethod
    public void pickFolder(PluginCall call) {
        startActivityForResult(call, new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), "pickDone");
    }

    @ActivityCallback
    private void pickDone(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            call.resolve();
            return;
        }
        String doc = DocumentsContract.getTreeDocumentId(data.getData()); // bijv. primary:Music/Vibe
        int c = doc.indexOf(':');
        String vol = c < 0 ? doc : doc.substring(0, c);
        String rel = c < 0 ? "" : doc.substring(c + 1);
        while (rel.endsWith("/")) rel = rel.substring(0, rel.length() - 1);
        String root = vol.equals("primary") ? Environment.getExternalStorageDirectory().getAbsolutePath() : "/storage/" + vol;
        JSObject o = new JSObject();
        o.put("abs", rel.isEmpty() ? root : root + "/" + rel);
        o.put("rel", rel);
        o.put("label", rel.isEmpty() ? "Hele telefoon" : rel);
        call.resolve(o);
    }

    @PluginMethod
    public void readText(PluginCall call) {
        JSObject o = new JSObject();
        try {
            File f = new File(call.getString("path", ""));
            if (f.isFile() && f.length() < 2000000) {
                o.put("text", new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8));
            }
        } catch (Exception ignored) { }
        call.resolve(o);
    }

    static Bitmap decodeScaled(byte[] b, int max) {
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(b, 0, b.length, o);
        int s = 1;
        while (o.outWidth / s > max * 2 || o.outHeight / s > max * 2) s *= 2;
        BitmapFactory.Options o2 = new BitmapFactory.Options();
        o2.inSampleSize = s;
        return BitmapFactory.decodeByteArray(b, 0, b.length, o2);
    }

    @PluginMethod
    public void cover(PluginCall call) {
        JSObject o = new JSObject();
        try {
            MediaMetadataRetriever r = new MediaMetadataRetriever();
            r.setDataSource(getContext(), Uri.parse(call.getString("uri", "")));
            byte[] b = r.getEmbeddedPicture();
            r.release();
            if (b != null) {
                Bitmap bm = decodeScaled(b, 640);
                if (bm != null) {
                    ByteArrayOutputStream bo = new ByteArrayOutputStream();
                    bm.compress(Bitmap.CompressFormat.JPEG, 85, bo);
                    o.put("data", "data:image/jpeg;base64," + Base64.encodeToString(bo.toByteArray(), Base64.NO_WRAP));
                }
            }
        } catch (Exception ignored) { }
        call.resolve(o);
    }

    // ---------- afspelen ----------

    private void cmd(String action, String key, Object value) {
        if (PlayerService.instance == null) return;
        Intent i = new Intent(getContext(), PlayerService.class).setAction(action);
        if (value instanceof Double) i.putExtra(key, (double) value);
        else if (value instanceof Boolean) i.putExtra(key, (boolean) value);
        else if (value instanceof Integer) i.putExtra(key, (int) value);
        getContext().startService(i);
    }

    @PluginMethod
    public void setQueue(PluginCall call) {
        try {
            List<String> ps = call.getArray("paths").toList();
            PlayerService.pendingPaths = ps.toArray(new String[0]);
        } catch (Exception e) {
            call.reject("Wachtrij ongeldig");
            return;
        }
        Intent i = new Intent(getContext(), PlayerService.class).setAction(PlayerService.A_QUEUE)
                .putExtra("index", call.getInt("index", 0))
                .putExtra("shuffle", call.getBoolean("shuffle", false))
                .putExtra("repeat", call.getInt("repeat", 0))
                .putExtra("qid", call.getData().optLong("qid", 0));
        getContext().startForegroundService(i);
        call.resolve();
    }

    @PluginMethod public void play(PluginCall call) { cmd(PlayerService.A_PLAY, null, null); call.resolve(); }
    @PluginMethod public void pause(PluginCall call) { cmd(PlayerService.A_PAUSE, null, null); call.resolve(); }
    @PluginMethod public void next(PluginCall call) { cmd(PlayerService.A_NEXT, null, null); call.resolve(); }
    @PluginMethod public void back(PluginCall call) { cmd(PlayerService.A_BACK, null, null); call.resolve(); }

    @PluginMethod
    public void seek(PluginCall call) {
        cmd(PlayerService.A_SEEK, "pos", call.getDouble("position", 0.0));
        call.resolve();
    }

    @PluginMethod
    public void setShuffle(PluginCall call) {
        cmd(PlayerService.A_SHUFFLE, "on", call.getBoolean("on", false));
        call.resolve();
    }

    @PluginMethod
    public void setRepeat(PluginCall call) {
        cmd(PlayerService.A_REPEAT, "mode", call.getInt("mode", 0));
        call.resolve();
    }

    @PluginMethod
    public void getState(PluginCall call) {
        PlayerService s = PlayerService.instance;
        JSObject o = new JSObject();
        JSArray paths = new JSArray();
        boolean has = false;
        if (s != null) {
            for (String p : s.paths()) paths.put(p);
            has = paths.length() > 0 && s.currentIndex() >= 0;
            o.put("playing", s.isPlaying());
            o.put("index", s.currentIndex());
            o.put("qid", s.currentQid());
            o.put("position", s.position());
            o.put("duration", s.duration());
        }
        o.put("has", has);
        o.put("paths", paths);
        call.resolve(o);
    }

    // ---------- overig ----------

    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url", "");
        if (url.startsWith("http")) {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        }
        call.resolve();
    }

    @PluginMethod
    public void setBars(PluginCall call) {
        int parsed;
        try {
            parsed = Color.parseColor(call.getString("color", "#14101c"));
        } catch (Exception e) {
            call.resolve();
            return;
        }
        final int color = parsed;
        final boolean light = call.getBoolean("light", false);
        getActivity().runOnUiThread(() -> {
            Window w = getActivity().getWindow();
            w.setStatusBarColor(color);
            w.setNavigationBarColor(color);
            View d = w.getDecorView();
            int f = d.getSystemUiVisibility();
            int mask = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            d.setSystemUiVisibility(light ? (f | mask) : (f & ~mask));
        });
        call.resolve();
    }
}
